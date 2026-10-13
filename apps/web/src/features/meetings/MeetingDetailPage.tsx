import {
  useCallback,
  useEffect,
  lazy,
  useLayoutEffect,
  useMemo,
  Suspense,
  useRef,
  useState,
} from 'react'

import type {
  FocusEvent,
  ReactNode,
} from 'react'
import {
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router'

import { ApiError } from '../../api/client'
import {
  addMeetingParticipant,
  createMeetingItem,
  createMeetingNote,
  createMeetingSection,
  deleteMeeting,
  deleteMeetingNote,
  deleteMeetingItem,
  endMeeting,
  focusMeetingItem,
  getMeeting,
  listMeetingItems,
  listMeetingParticipants,
  listMeetingSections,
  markMeetingItemDone,
  reorderMeetingSections,
  reopenMeeting,
  reopenMeetingItem,
  removeMeetingParticipant,
  searchMeetingParticipantCandidates,
  startMeeting,
  updateMeetingItem,
  updateMeetingNote,
  updateMeetingSection,
} from '../../api/meetings'
import {
  getProject,
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
import { MeetingFollowUpSchedulingDialog } from './MeetingFollowUpSchedulingDialog'
import { MeetingCancelFollowUpDialog } from './MeetingCancelFollowUpDialog'
import {
  AGENDA_STATUS_META,
  agendaStatusMeta,
  type AgendaItemOutcome,
} from './agendaStatus'
import { CompletedMeetingRecap } from './CompletedMeetingRecap'
import {
  meetingsListReturnDestination,
} from './meetingsNavigation'
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
import {
  NoteLinkedWorkCard,
  NoteLinkedWorkCaption,
} from './noteLinkedWork'
import {
  TopicMarkdownComposer,
  TopicMarkdownDisplay,
} from './TopicMarkdown'

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
  ApiCancelMeetingItemFollowUpResult,
  ApiMeeting,
  ApiMeetingItem,
  ApiMeetingNote,
  ApiMeetingParticipant,
  ApiMeetingSection,
  ApiLinkedWorkItem,
  ApiMeetingParticipantCandidate,
  ApiProject,
  ApiProjectMembership,
  ApiProjectWorkItemConfiguration,
  ApiUpdateWorkItemInput,
  ApiWorkItem,
  ApiWorkItemType,
} from '../../api/types'
import { useSyncResearchGroupContext } from '../research-group/useSyncResearchGroupContext'

import './MeetingDetailPage.css'

// Live Meeting chrome uses one compact control family. Variants change
// hierarchy and meaning without changing the 28px navigation-scale anatomy.
const LIVE_CONTROL_BASE =
  'inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-xs leading-[18px] font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-60'
const LIVE_CONTROL_TERTIARY =
  `${LIVE_CONTROL_BASE} border border-transparent bg-transparent text-text-muted hover:bg-surface-hover hover:text-text`
const LIVE_CONTROL_SECONDARY =
  `${LIVE_CONTROL_BASE} border border-default bg-transparent text-text-muted hover:bg-surface-hover hover:text-text`
const LIVE_CONTROL_SUCCESS =
  `${LIVE_CONTROL_BASE} border border-transparent bg-success text-text-inverse hover:brightness-110`
const LIVE_CONTROL_DANGER =
  `${LIVE_CONTROL_BASE} border border-default bg-transparent text-danger hover:bg-danger-bg hover:border-danger hover:text-danger`
const LIVE_CONTROL_ICON =
  'material-symbols-outlined text-[14px] leading-none'

// Agenda creation is tertiary navigation chrome, visually quieter
// than a topic row while retaining a practical 28px minimum target.
// Keep this local: the shared navigation roles and wider Live control
// family intentionally remain unchanged.
const LIVE_AGENDA_ADD_ACTION =
  'fg-live-agenda-add-action inline-flex min-h-7 items-center gap-1 rounded bg-transparent px-1.5 text-left text-text-tertiary outline-none transition-colors hover:bg-surface-hover hover:text-text-muted focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-60'
const LIVE_AGENDA_ADD_ICON =
  'material-symbols-outlined fg-live-agenda-add-icon'

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

// ── Upcoming preparation presentation helpers (approved Stitch
// design): compact date/clock labels and row authorship recency. ──

function formatMeetingDayLabel(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  const startOfDay = (input: Date): Date =>
    new Date(
      input.getFullYear(),
      input.getMonth(),
      input.getDate(),
    )

  const dayDiff = Math.round(
    (startOfDay(new Date()).getTime() -
      startOfDay(date).getTime()) /
    86_400_000,
  )

  if (dayDiff === 0) {
    return 'Today'
  }

  if (dayDiff === 1) {
    return 'Tomorrow'
  }

  return new Intl.DateTimeFormat('en', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function formatMeetingClock(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

// Compact relative time for agenda row authorship metadata
// ("2h ago", "Yesterday"), matching the approved design.
function formatItemRelativeTime(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  const diffMinutes = Math.round(
    (Date.now() - date.getTime()) / 60_000,
  )

  if (diffMinutes < 1) {
    return 'just now'
  }

  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`
  }

  const diffHours = Math.round(diffMinutes / 60)

  if (diffHours < 24) {
    return `${diffHours}h ago`
  }

  const startOfDay = (input: Date): Date =>
    new Date(
      input.getFullYear(),
      input.getMonth(),
      input.getDate(),
    )

  const dayDiff = Math.round(
    (startOfDay(new Date()).getTime() -
      startOfDay(date).getTime()) /
    86_400_000,
  )

  if (dayDiff <= 1) {
    return 'Yesterday'
  }

  if (dayDiff < 7) {
    return `${dayDiff}d ago`
  }

  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

// The approved Stitch shortcut hint keys on the platform (⌘K on
// Mac); both Cmd and Ctrl focus the Quick Add input.
const isMacLike =
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad|ipod/i.test(navigator.userAgent)

function MenuItem({
  preparation = false,
  label,
  icon,
  danger,
  disabled,
  onClick,
}: {
  preparation?: boolean
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
        preparation
          ? `focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset ${danger ? 'text-danger hover:bg-danger-bg' : 'text-text hover:bg-surface-hover'}`
          : danger
          ? 'text-danger hover:bg-danger-bg focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset'
          : 'text-text hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset',
        disabled ? 'pointer-events-none opacity-45' : '',
      ].join(' ')}
    >
      {icon && (
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[17px] text-text-muted"
        >
          {icon}
        </span>
      )}

      <span className="truncate">{label}</span>
    </button>
  )
}

function MenuTrigger({
  preparation = false,
  compact = false,
  label,
  ariaLabel,
  children,
}: {
  preparation?: boolean
  compact?: boolean
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
        className={
          compact
            ? [
                'flex h-7 w-7 items-center justify-center rounded text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus',
                open ? 'bg-surface-hover text-text' : '',
              ].join(' ')
            : [
                'flex h-8 w-8 items-center justify-center rounded-lg text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                open ? 'bg-surface-hover text-text' : '',
                preparation && !open
                  ? 'group-hover/menu:bg-surface-hover'
                  : '',
              ].join(' ')
        }
      >
        <span
          aria-hidden="true"
          className={`material-symbols-outlined ${compact ? 'text-[16px]' : 'text-[18px]'}`}
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
          className="z-50 w-52 rounded-xl border border-border-subtle bg-surface p-1 shadow-lg"
        >
          {children(open, toggle)}
        </div>
      )}
    </div>
  )
}

// Seamless MeetingNote editor, shared by the new-Note composer and
// existing-Note editing: the displayed Note (or a blank writing
// surface) is replaced by a borderless, transparent, auto-growing
// textarea in the SAME position (no padding of its own, so the text
// stays put; the approved Note typography text-sm/leading-6/text-
// text is reused verbatim). There is no input box, card, or panel:
// the quiet keyboard-focus indication is a 1px accent underline
// under the text (a full transparent bottom border reserves the
// space, so nothing shifts).
//
// Persistence is AUTOMATIC and there are no visible Save/Cancel
// controls: focus-leave commits the draft (the caller decides
// create / update / no-op), Escape discards it (the suppress flag
// keeps the resulting blur or unmount from committing), and save
// feedback is a quiet one-line status inside the editor (while
// pending or on failure) — never a toolbar. In the composer, the
// quiet "Create work item" action sits below the writing surface.
// The outcome of one MeetingNote persistence (save or create).
// `ok` gates the Done transition (a failed persistence must not
// complete the topic); the post-settle surface state tells the
// Done flow whether the editor/composer legitimately stayed open
// (a failed commit keeps its draft; a save keeps the editor open
// when a NEWER draft was typed while it was in flight) so it can
// re-commit instead of re-reading stale render state.
type NoteCommitResult = {
  ok: boolean
  kind: 'save' | 'create'
  editorStillOpen: boolean
  composerStillOpen: boolean
}

function NoteInlineEditor({
  value,
  placeholder,
  ariaLabel,
  savingLabel,
  error,
  onValueChange,
  onCommitDraft,
  onEscape,
  workItemAction,
}: {
  value: string
  placeholder?: string
  ariaLabel: string
  savingLabel: string | null
  error: string | null
  onValueChange: (value: string) => void
  onCommitDraft: () => void
  onEscape: () => void
  workItemAction?: {
    label: string
    disabled: boolean
    onClick: () => void
  } | null
}) {
  const textareaRef = useRef<
    HTMLTextAreaElement
  >(null)
  const editorRootRef = useRef<HTMLDivElement>(null)
  // Escape must not commit through the focus-leave (or unmount)
  // that follows.
  const suppressCommitRef = useRef(false)

  // Auto-expand with the content (the established
  // TopicMarkdownComposer pattern): no fixed height, no internal
  // scrolling, no clipping. A single-line Note opens at one line;
  // new line breaks grow the field. The effect only touches
  // layout height — never focus or selection.
  useLayoutEffect(() => {
    const el = textareaRef.current

    if (el == null) {
      return
    }

    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  const handleBlur = (
    event: FocusEvent<HTMLDivElement>,
  ) => {
    if (suppressCommitRef.current) {
      suppressCommitRef.current = false
      return
    }

    // Moving from the writing surface to its Work Item action is
    // still inside the composer. Let that action receive its click
    // or keyboard activation before persistence changes the tree.
    // A transition beyond the composer remains ordinary autosave.
    if (
      event.relatedTarget instanceof Node &&
      editorRootRef.current?.contains(
        event.relatedTarget,
      )
    ) {
      return
    }

    onCommitDraft()
  }

  return (
    <div
      ref={editorRootRef}
      onBlur={handleBlur}
    >
      <textarea
        ref={textareaRef}
        value={value}
        placeholder={placeholder}
        onChange={(event) =>
          onValueChange(event.target.value)
        }
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            suppressCommitRef.current = true
            onEscape()
          }
        }}
        autoFocus
        rows={1}
        aria-label={ariaLabel}
        className="block w-full resize-none overflow-hidden whitespace-pre-wrap border-b border-transparent bg-transparent p-0 text-sm leading-6 text-text outline-none focus:border-accent"
      />

      {error != null ? (
        <p
          role="alert"
          className="mt-1 text-[11px] leading-[16px] text-danger"
        >
          {error}
        </p>
      ) : savingLabel != null ? (
        <p
          role="status"
          className="mt-1 text-[11px] leading-[16px] text-text-tertiary"
        >
          {savingLabel}
        </p>
      ) : null}

      {workItemAction != null && (
        <div className="mt-1 flex items-center">
          <button
            type="button"
            disabled={
              workItemAction.disabled
            }
            onClick={
              workItemAction.onClick
            }
            aria-label={
              workItemAction.label
            }
            className="rounded px-0.5 text-[11px] leading-[16px] text-text-tertiary outline-none transition hover:text-text focus-visible:ring-1 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-60"
          >
            {workItemAction.label}
          </button>
        </div>
      )}
    </div>
  )
}

// Quick Add section destination selector: a quiet text button with
// the Stitch arrow affordance. Lists the Meeting's VISIBLE sections
// only; the selection is presentation state that decides where the
// created item lands.
function QuickAddSectionSelect({
  sections,
  selectedId,
  onSelect,
  disabled,
}: {
  sections: ApiMeetingSection[]
  selectedId: number | null
  onSelect: (id: number) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
  })
  const ref = useRef<HTMLDivElement>(null)
  const selected =
    sections.find(
      (section) => section.id === selectedId,
    ) ?? sections[0] ?? null

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
    if (disabled) {
      return
    }

    if (!open && ref.current) {
      const rect =
        ref.current.getBoundingClientRect()

      setPosition({
        top: rect.bottom + 6,
        left: Math.max(8, rect.left),
      })
    }

    setOpen((current) => !current)
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Quick add section"
        className="flex shrink-0 items-center gap-1 text-[13px] font-medium text-text outline-none transition hover:text-text focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
      >
        <span>
          {selected ? selected.name : 'Select a section'}
        </span>
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[14px] text-text-muted"
        >
          arrow_drop_down
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
          className="z-50 w-52 rounded-xl border border-border-subtle bg-surface p-1 shadow-lg"
        >
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              role="menuitem"
              onClick={() => {
                onSelect(section.id)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-text outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
            >
              <span className="flex-1 truncate">
                {section.name}
              </span>

              {section.id === selected?.id && (
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined text-[16px] text-accent-text"
                >
                  check
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      </div>
    )
}

// ── Live Meeting header: elapsed timer ─────────────────────────
// Compact "mm:ss" (or "h:mm:ss" beyond one hour) elapsed-time
// label derived from the Meeting's persisted startedAt.
function formatLiveElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const paddedMinutes = String(minutes).padStart(2, '0')
  const paddedSeconds = String(seconds).padStart(2, '0')

  return hours > 0
    ? `${hours}:${paddedMinutes}:${paddedSeconds}`
    : `${paddedMinutes}:${paddedSeconds}`
}

// The ticking elapsed time lives in this leaf component ONLY: the
// 1-second interval re-render touches the label, never the Meeting
// page. A missing/invalid startedAt renders nothing (the pill then
// shows "Live" without a time).
function LiveElapsedTimer({
  startedAt,
}: {
  startedAt: string | null
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(
      () => setNow(Date.now()),
      1000,
    )

    return () => window.clearInterval(id)
  }, [])

  if (startedAt == null) {
    return null
  }

  const startedMs = new Date(startedAt).getTime()

  if (Number.isNaN(startedMs)) {
    return null
  }

  return (
    <span aria-hidden="true">
      {' · '}
      {formatLiveElapsed(now - startedMs)}
    </span>
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

  // The unified return contract for every list-return action on
  // this page (completed header, error / unavailable-detail
  // fallback, and the successful deletion redirect): the detail's
  // own `from` origin, validated against the known Meetings tab
  // identifiers. Missing or invalid origins fall back safely to
  // /meetings — the value is never interpreted as a URL or
  // navigation destination.
  const [detailSearchParams] = useSearchParams()
  const meetingsReturnDestination =
    meetingsListReturnDestination(
      detailSearchParams.get('from'),
    )

  const [meeting, setMeeting] =
    useState<ApiMeeting | null>(null)

  useSyncResearchGroupContext(
    meeting?.researchGroupId,
  )

  const [participants, setParticipants] =
    useState<ApiMeetingParticipant[]>([])

  const [items, setItems] =
    useState<ApiMeetingItem[]>([])

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] =
    useState<string | null>(null)

  const [actionError, setActionError] =
    useState<string | null>(null)

  const [participantQuery, setParticipantQuery] =
    useState('')

  const [participantCandidates, setParticipantCandidates] =
    useState<ApiMeetingParticipantCandidate[]>([])

  const [searchingParticipants, setSearchingParticipants] =
    useState(false)

  const [
    participantSearchError,
    setParticipantSearchError,
  ] = useState<string | null>(null)

  const participantSearchVersion = useRef(0)

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

  // ── Upcoming Quick Add bar (top of the preparation view) ──
  // Presentation-local state only: the draft title and the selected
  // destination section. Creation goes through the canonical
  // createMeetingItem path; nothing is persisted here.
  const [quickAddTitle, setQuickAddTitle] =
    useState('')
  const [
    quickAddSectionId,
    setQuickAddSectionId,
  ] = useState<number | null>(null)
  const [
    quickAddCreating,
    setQuickAddCreating,
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

  // Inline section creation: whether the compact name
  // input is currently open directly below the section
  // list (or inside the empty state).
  const [
    sectionComposerOpen,
    setSectionComposerOpen,
  ] = useState(false)
  const sectionComposerInputRef =
    useRef<HTMLInputElement>(null)

  // The composer input is focused as soon as it opens.
  useEffect(() => {
    if (sectionComposerOpen) {
      sectionComposerInputRef.current?.focus()
    }
  }, [sectionComposerOpen])

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
  // The topic draft lives inside TopicMarkdownComposer itself
  // (verbatim Markdown, preserved across failed saves); the page
  // only tracks which item is being edited and whether the save is
  // in flight.
  const [savingItemId, setSavingItemId] =
    useState<number | null>(null)
  // Synchronous in-flight guard for the agenda item deletion
  // (same pattern as the note-delete guard): React state is
  // batched, so a rapid repeated activation within one tick
  // must observe the in-flight DELETE through the ref — a
  // duplicate deletion is never started.
  const deleteItemInFlightRef = useRef(false)

  // In-flight flag for the section-local creation composer (its
  // draft is composer-local; there is no item id yet).
  const [creatingItem, setCreatingItem] =
    useState(false)

  const [updatingItemId, setUpdatingItemId] =
    useState<number | null>(null)

  // Live Meeting: the agenda item the user is currently VIEWING in the
  // detail pane. Purely local UI navigation (never persisted). "Current"
  // (persisted on the Meeting as currentMeetingItemId) is a distinct,
  // domain concept; selecting an item must not change it.
  const [selectedItemId, setSelectedItemId] =
    useState<number | null>(null)

  const [followUpSourceItem, setFollowUpSourceItem] =
    useState<ApiMeetingItem | null>(null)
  const followUpTriggerRef =
    useRef<HTMLButtonElement>(null)

  // Cancellation dialog source (selected item with an active
  // followUpSchedule) + the destination notice for preserved targets.
  const [cancelFollowUpSourceItem, setCancelFollowUpSourceItem] =
    useState<ApiMeetingItem | null>(null)
  const cancelFollowUpTriggerRef =
    useRef<HTMLButtonElement>(null)
  const [preservedFollowUpNotice, setPreservedFollowUpNotice] =
    useState<string | null>(null)

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
  // Synchronous in-flight guard for the composer's create: React
  // state is batched, so a blur + a "Create work item" click within
  // one tick must both observe the same create as in flight.
  const composerCreateInFlightRef =
    useRef(false)
  // The item whose composer create should open the Work Item
  // dialog once it succeeds (set by the quiet "Create work item"
  // affordance; read on the in-flight create's resolve).
  const composerWorkItemIntentRef =
    useRef<number | null>(null)
  // Quiet inline error for the active Note editor (new or
  // existing); shown inside the editor, never in a toolbar.
  const [noteError, setNoteError] =
    useState<string | null>(null)
  const [
    editingNoteId,
    setEditingNoteId,
  ] = useState<number | null>(null)
  const [
    noteEditContent,
    setNoteEditContent,
  ] = useState('')
  // Always-fresh mirror of the edit draft: an in-flight save's
  // resolve must compare against the CURRENT draft (keystrokes
  // typed while the save is pending) to avoid closing the editor
  // and discarding a newer edit.
  const noteEditContentRef = useRef(noteEditContent)
  noteEditContentRef.current = noteEditContent
  // The Done activation captured on the Done button's pointerdown.
  // It fires BEFORE the focus-out autosave, so the autosave can
  // defer to the combined commit + Done flow instead of running
  // ahead of it: its "Saving…"/"Adding…" status line would
  // otherwise land in the flow above the action row between
  // mousedown and mouseup, shift the Done button out from under
  // the cursor, and make the browser deliver the click to the row
  // instead of the button (first click lost, second required).
  const doneIntentRef = useRef<
    ApiMeetingItem | null
  >(null)
  // The single Note persistence in flight for the Live item (a
  // save or a create) so the Done flow can AWAIT it instead of
  // starting a duplicate. The result carries the post-settle
  // surface state (the editor/composer may legitimately stay
  // open: a failed commit keeps its draft, and a save keeps the
  // editor open when a NEWER draft was typed while it was in
  // flight). The ref (unlike React state) is current inside
  // awaited continuations, so commit guards read it, not the
  // per-render `savingNoteId`/`creatingNoteItemId` state.
  const noteCommitInFlightRef = useRef<{
    itemId: number
    kind: 'save' | 'create'
    promise: Promise<NoteCommitResult>
  } | null>(null)
  // Synchronous guard for the combined Done flow: React state is
  // batched, so the ref is the only guard that observes a
  // repeated activation within one tick.
  const doneFlowInFlightRef = useRef(false)
  // Always-fresh entry for the pointercancel fallback: a system-
  // cancelled Done gesture must still run the focus-leave
  // autosave that was deferred for it (the listener is attached
  // once, so it resolves the CURRENT render's handlers through
  // this ref).
  const noteSurfaceAutosaveRef = useRef<(
    item: ApiMeetingItem,
  ) => void>(() => {})
  noteSurfaceAutosaveRef.current = (item) => {
    const editingId =
      editingNoteIdRef.current
    if (editingId != null) {
      const note = (item.notes ?? []).find(
        (candidate) =>
          candidate.id === editingId,
      )
      if (note != null) {
        handleNoteEditBlur(item, note)
        return
      }
    }
    if (noteComposerItemIdRef.current === item.id) {
      handleComposerBlur(item)
    }
  }
  // Always-fresh mirrors for the Done flow: after an awaited
  // commit the flow's render closure is stale, but these
  // per-render mirrors (and the synchronous refs above) are
  // current.
  const noteDraftContentRef = useRef(noteDraftContent)
  noteDraftContentRef.current = noteDraftContent
  const editingNoteIdRef = useRef(editingNoteId)
  editingNoteIdRef.current = editingNoteId
  const noteComposerItemIdRef =
    useRef(noteComposerItemId)
  noteComposerItemIdRef.current = noteComposerItemId
  const itemsRef = useRef(items)
  itemsRef.current = items
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

  // Focus management for the note-delete confirmation: the dialog
  // container (Tab trap), the Delete confirmation (initial focus)
  // and the trigger that opened the dialog (focus restoration).
  // The synchronous in-flight ref guards a repeated Enter within
  // one tick — React state is batched, so `deletingNoteId` alone
  // would not yet observe the in-flight delete (same race as the
  // composer create).
  const noteDeleteDialogRef =
    useRef<HTMLDivElement>(null)
  const noteDeleteConfirmRef =
    useRef<HTMLButtonElement>(null)
  const noteDeleteReturnFocusRef =
    useRef<HTMLButtonElement | null>(null)
  const noteDeleteInFlightRef =
    useRef(false)
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

  // The Upcoming Quick Add bar input (Cmd/Ctrl+K target). Kept
  // separate from the section-local composer's quickAddInputRef.
  const topQuickAddInputRef =
    useRef<HTMLInputElement>(null)

  const { user } = useSession()
  const { activeResearchGroup } = useResearchGroup()

  // Current Research Group membership (any role) of the user in the
  // Meeting's group — the canonical group-scope Meeting collaboration
  // boundary. Admin status is NOT a gate.
  const isGroupMember = useMemo(() => {
    if (user == null) {
      return false
    }

    return (
      activeResearchGroup?.id === meeting?.researchGroupId
    )
  }, [activeResearchGroup, user, meeting?.researchGroupId])

  // For a Project Meeting, load the Project read-model of the Meeting's
  // Project: the current user's Project access (any role satisfies the
  // canonical Project-read boundary) and the archived state decide
  // Meeting collaboration. A 404 (no access) leaves it null.
  const [project, setProject] = useState<ApiProject | null>(null)

  useEffect(() => {
    if (meeting == null || meeting.scope !== 'project') {
      setProject(null)

      return
    }

    if (meeting.projectId == null) {
      setProject(null)

      return
    }

    let cancelled = false

    getProject(meeting.projectId)
      .then((loadedProject) => {
        if (!cancelled) {
          setProject(loadedProject)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProject(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [meeting])

  // Meeting collaboration mirrors the server's canonical
  // MEETING_WRITE rule: a group Meeting is fully collaborative for
  // every current Research Group member; a Project Meeting is
  // collaborative for its creator or explicit participants with valid
  // current Project access (any Project role) while the Project is not
  // archived. Meeting collaboration never grants Project/Work Item
  // permissions, and the moderator is not an authorization gate.
  // The server remains authoritative; this only decides whether to
  // render the controls.
  const canManageLifecycle = useMemo(() => {
    if (meeting == null || user == null) {
      return false
    }

    if (meeting.scope === 'group') {
      return isGroupMember
    }

    if (meeting.projectId == null) {
      return false
    }

    const isMeetingCollaborator =
      meeting.createdById === user.id ||
      meeting.participantIds.includes(user.id)

    if (!isMeetingCollaborator) {
      return false
    }

    if (project == null || project.archivedAt != null) {
      return false
    }

    return true
  }, [meeting, isGroupMember, user, project])

  // Destructive Meeting administration mirrors the server's canonical
  // MEETING_ADMIN rule: a group Meeting is fully manageable by every
  // current Research Group member; a Project Meeting destructive
  // action (Delete meeting, removing a participant) additionally
  // requires the existing Project write role (owner or member) while
  // the Project is not archived. A viewer-participant collaborates
  // (Start/Edit/add participants) but does NOT get these controls.
  // The server remains authoritative; this only decides whether to
  // render the controls.
  const canAdministerMeeting = useMemo(() => {
    if (meeting == null || user == null) {
      return false
    }

    if (meeting.scope === 'group') {
      return isGroupMember
    }

    if (meeting.projectId == null) {
      return false
    }

    const isMeetingCollaborator =
      meeting.createdById === user.id ||
      meeting.participantIds.includes(user.id)

    if (!isMeetingCollaborator) {
      return false
    }

    if (project == null || project.archivedAt != null) {
      return false
    }

    return (
      project.currentUserRole === 'owner' ||
      project.currentUserRole === 'member'
    )
  }, [meeting, isGroupMember, user, project])

  // Monotonic load-sequence guard: every load claims a sequence
  // number and only the newest load may apply its terminal state
  // writes. The React StrictMode development double-effect (and an
  // interrupted meeting-to-meeting navigation) can leave an earlier
  // duplicate load in flight while the user already interacts with
  // the page rendered by the newer load; without this guard the
  // stale load's late terminal writes would clobber that state -
  // in particular its fresh-load selection reset would silently
  // wipe a selection the user made in between.
  const loadSeqRef = useRef(0)

  const loadMeeting = useCallback(async () => {
    const seq = ++loadSeqRef.current
    const isCurrent = () => seq === loadSeqRef.current

    if (meetingId == null) {
      setMeeting(null)
      setParticipants([])
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
      if (!isCurrent()) return

      const [
        nextParticipants,
        nextItems,
        nextSections,
      ] = await Promise.all([
        listMeetingParticipants(meetingId),
        listMeetingItems(meetingId),
        listMeetingSections(meetingId),
      ])
      if (!isCurrent()) return

      setMeeting(nextMeeting)
      setParticipants(nextParticipants)
      setItems(nextItems)
      setSections(nextSections)
      // A fresh load/re-entry resets local selection to the Meeting's
      // actual current item (selection is never persisted).
      setSelectedItemId(nextMeeting.currentMeetingItemId)
      setPreservedFollowUpNotice(null)
    } catch (error) {
      if (!isCurrent()) return
      setMeeting(null)
      setParticipants([])
      setItems([])
      setSections([])

      setLoadError(
        getErrorMessage(
          error,
          'Meeting could not be loaded.',
        ),
      )
    } finally {
      if (isCurrent()) setLoading(false)
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

  // The approved Quick Add shortcut: Cmd/Ctrl+K focuses the top
  // Quick Add input on the Upcoming preparation view.
  useEffect(() => {
    if (meeting?.status !== 'upcoming') {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        (event.key === 'k' || event.key === 'K')
      ) {
        event.preventDefault()
        topQuickAddInputRef.current?.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [meeting?.status])


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

  // Candidate discovery for participant management. The server
  // restricts results to users eligible for the Meeting's ACTUAL scope
  // (group: current Research Group members; project: users with valid
  // current Project access), so the client only excludes the people
  // that are already participants.
  const availableParticipants = useMemo(
    () =>
      participantCandidates.filter(
        (candidate) =>
          !participantUserIds.has(candidate.id),
      ),
    [participantCandidates, participantUserIds],
  )

  const participantSearchActive =
    participantQuery.trim().length >= 2

  // Debounced candidate search while participant management is open.
  useEffect(() => {
    if (!managingParticipants || meeting == null) {
      return
    }

    const query = participantQuery.trim()

    participantSearchVersion.current += 1
    const version = participantSearchVersion.current

    setParticipantCandidates([])
    setSearchingParticipants(false)
    setParticipantSearchError(null)

    if (query.length < 2) {
      return
    }

    const timeout = window.setTimeout(() => {
      setSearchingParticipants(true)

      void searchMeetingParticipantCandidates(
        meeting.id,
        query,
      )
        .then((results) => {
          if (participantSearchVersion.current === version) {
            setParticipantCandidates(results)
          }
        })
        .catch(() => {
          if (participantSearchVersion.current === version) {
            setParticipantSearchError(
              'People could not be searched.',
            )
          }
        })
        .finally(() => {
          if (participantSearchVersion.current === version) {
            setSearchingParticipants(false)
          }
        })
    }, 250)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [managingParticipants, meeting, participantQuery])

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

  // Agenda row authorship: resolve the item's creator to a Meeting
  // participant's user (the API carries createdById only).
  const participantUserById = useMemo(() => {
    const map = new Map<
      number,
      ApiMeetingParticipant['user']
    >()

    for (const participant of participants) {
      map.set(participant.user.id, participant.user)
    }

    return map
  }, [participants])

  // The Quick Add bar's effective destination: the explicit
  // selection while it is still a visible section, otherwise the
  // first visible section.
  const quickAddTargetSection = useMemo(() => {
    if (visibleSections.length === 0) {
      return null
    }

    return (
      visibleSections.find(
        (section) => section.id === quickAddSectionId,
      ) ?? visibleSections[0]
    )
  }, [visibleSections, quickAddSectionId])

  const handleAddParticipant = async (
    candidate: ApiMeetingParticipantCandidate,
  ) => {
    if (
      meetingId == null ||
      addingParticipant
    ) {
      return
    }

    const userId = candidate.id

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

      setParticipantCandidates((current) =>
        current.filter(
          (entry) => entry.id !== participant.user.id,
        ),
      )
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

  const toggleParticipantManagement = () => {
    setManagingParticipants((value) => {
      const next = !value

      if (next) {
        requestAnimationFrame(() => {
          document
            .querySelector<HTMLInputElement>(
              'input[data-participant-search]',
            )
            ?.focus()
        })
      }

      return next
    })
  }

  // Canonical topic creation: the Markdown source is AUTHORITATIVE
  // (the server derives the compatibility title); the client never
  // sends title / notes alongside content. Errors propagate to the
  // caller — the preparation composer shows them inline and keeps
  // its draft, the Live quick-add surfaces them via the page
  // action-error banner.
  const handleCreateItemInSection = async (
    section: ApiMeetingSection,
    content: string,
  ) => {
    // Client-side mirror of the server's authoritative Meeting
    // write check: never submit an unauthorized create, even if a
    // stale render left a composer open.
    if (!canManageLifecycle) {
      return
    }

    if (meetingId == null) {
      return
    }

    if (content.trim() === '') {
      return
    }

    const item = await createMeetingItem(
      meetingId,
      {
        meetingSectionId: section.id,
        content,
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
  }

  // Top Quick Add bar: creates through the same canonical
  // createMeetingItem path as the section-local composer, using
  // the bar's selected visible section as destination.
  const handleQuickAddSubmit = async () => {
    if (meetingId == null || quickAddCreating) {
      return
    }

    const section = quickAddTargetSection
    const title = quickAddTitle.trim()

    if (section == null || !title) {
      return
    }

    setQuickAddCreating(true)
    setActionError(null)

    try {
      const item = await createMeetingItem(
        meetingId,
        {
          meetingSectionId: section.id,
          // Canonical content write: a one-line quick-add topic is
          // valid Markdown; the server derives the title.
          content: title,
        },
      )

      setItems((current) => [
        ...current.filter(
          (candidate) => candidate.id !== item.id,
        ),
        item,
      ])
      setQuickAddTitle('')
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Agenda item could not be created.',
        ),
      )
    } finally {
      setQuickAddCreating(false)
    }
  }

  const closeSectionComposer = () => {
    setSectionComposerOpen(false)
    setNewSectionName('')
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
      // Success: the section is appended in its
      // authoritative server position and the composer
      // returns to the normal view.
      closeSectionComposer()
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Section could not be created.',
        ),
      )
      // Failure: the draft stays in the open composer so
      // the user can retry without retyping.
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
      const updatedSections = await reorderMeetingSections(meetingId!, {
        sectionIds: reordered.map(
          (s) => s.id,
        ),
      })
      setSections(updatedSections)
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
    // The rendered content is the entry point: the composer mounts
    // in the same row and initializes from the canonical content
    // (verbatim; no title / notes reconstruction).
    setEditingItemId(item.id)
  }

  const handleSaveItem = async (
    item: ApiMeetingItem,
    content: string,
  ) => {
    if (savingItemId != null) {
      return
    }

    setSavingItemId(item.id)

    try {
      const updated = await updateMeetingItem(
        item.id,
        {
          // Canonical content write: the ENTIRE Markdown source,
          // verbatim — never a legacy title / notes pair (content-
          // authored items would reject it server-side anyway).
          content,
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
      // Re-throw so the composer keeps the draft and shows the
      // error inline (preserving uncommitted edits after a failed
      // save is part of the contract).
      throw error
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

    // Duplicate-activation guard: a second activation while the
    // server request is in flight must not start a second
    // DELETE for the same item.
    if (deleteItemInFlightRef.current) {
      return
    }

    setActionError(null)
    deleteItemInFlightRef.current = true

    try {
      // The shared API client rejects EVERY non-2xx response:
      // the item is removed from local state only after the
      // server has confirmed the deletion (204). A rejected
      // deletion keeps the item visible with a meaningful
      // error.
      await deleteMeetingItem(item.id)

      setItems((current) =>
        current.filter(
          (candidate) => candidate.id !== item.id,
        ),
      )

      // Item-specific local UI state loses its target after a
      // confirmed deletion; unrelated drafts, the Meeting
      // status, and the persisted current pointer stay untouched.
      if (editingItemId === item.id) {
        setEditingItemId(null)
      }
      if (selectedItemId === item.id) {
        setSelectedItemId(null)
      }
      if (noteComposerItemId === item.id) {
        setNoteComposerItemId(null)
        setNoteDraftContent('')
      }
      if (
        editingNoteId != null &&
        item.notes.some((note) => note.id === editingNoteId)
      ) {
        setEditingNoteId(null)
        setNoteEditContent('')
      }
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          'Agenda item could not be deleted.',
        ),
      )
    } finally {
      deleteItemInFlightRef.current = false
    }
  }

  // ── Live Meeting: local selection (decoupled from "current") ──
  // Selecting an agenda item is pure UI navigation: it only changes
  // which item the detail pane shows. It never touches the persisted
  // current pointer or any item outcome.
  const handleSelectLiveItem = (item: ApiMeetingItem) => {
    setSelectedItemId(item.id)
    setPreservedFollowUpNotice(null)
  }

  // "Return to current": re-point local selection at the Meeting's
  // actual current item. No domain mutation.
  const handleReturnToCurrent = () => {
    if (meeting?.currentMeetingItemId != null) {
      setSelectedItemId(meeting.currentMeetingItemId)
      setPreservedFollowUpNotice(null)
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
      // A following selection tracks the freshly-read current
      // pointer exactly — including a null pointer (no current
      // item remains). `newCurrentId` is always taken from the
      // server response or the post-action re-read, never from the
      // render-closure `meeting` (which may still hold the
      // pre-action pointer when the caller updates it in the same
      // batch).
      const resolvedCurrent =
        wasFollowing
          ? newCurrentId
          : newCurrentId ?? meeting?.currentMeetingItemId ?? null
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

  // Done and concrete follow-up scheduling are resolving actions. After
  // either succeeds, re-read the canonical Meeting pointer instead of
  // deriving an agenda successor in the client. A non-null server Current
  // becomes Selected; when the server clears Current, retain the resolved
  // source item as useful local context.
  const refreshAfterResolvingCurrent = async (
    sourceItemId: number,
    sourceWasCurrent: boolean,
  ) => {
    await refreshItems()
    const nextMeeting = await refreshMeeting()

    if (!sourceWasCurrent || nextMeeting == null) return
    setSelectedItemId(
      nextMeeting.currentMeetingItemId ?? sourceItemId,
    )
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

  // Resolves the item's pending MeetingNote state BEFORE a Done
  // transition: it settles an in-flight save/create (started by
  // the focus-leave autosave) and persists any open
  // editor/composer draft through the single commit paths — the
  // topic is never marked Done with unsaved Note changes behind
  // it. A failed persistence returns false (the draft and the
  // inline error stay in the editor; the topic must not be
  // completed). The first pass reads the per-render mirrors
  // (fresh: no await has run yet); later passes trust the
  // post-settle surface state carried by the commit results,
  // because the flow's render closure (and mirrors) are stale
  // after an awaited settle.
  const ensureItemNotesPersisted =
    async (item: ApiMeetingItem):
      Promise<boolean> => {
      let editor:
        'unknown' | 'closed' | 'advanced' =
        'unknown'
      let composer:
        'unknown' | 'closed' = 'unknown'
      let firstPassNote:
        ApiMeetingNote | null = null

      // Bounded: one round per settled commit, plus follow-up
      // rounds for drafts that advanced while a save was in
      // flight.
      for (
        let round = 0;
        round < 8;
        round++
      ) {
        const inFlight =
          noteCommitInFlightRef.current
        if (
          inFlight != null &&
          inFlight.itemId === item.id
        ) {
          const result = await inFlight.promise
          if (!result.ok) return false
          if (result.kind === 'save') {
            editor =
              result.editorStillOpen
                ? 'advanced'
                : 'closed'
          } else {
            // A settled create closed the composer (a failure
            // would have returned false above).
            composer = 'closed'
          }
          continue
        }

        const itemNotes = item.notes ?? []
        let startedCommit = false

        if (editor === 'advanced') {
          // A NEWER draft was typed while the previous save was
          // in flight: re-commit it (the mirror holds the newer
          // content; the note id is stable).
          const note =
            firstPassNote ??
            itemNotes.find(
              (candidate) =>
                candidate.id ===
                editingNoteIdRef.current,
            )
          if (note != null) {
            void saveNoteEdit(item, note)
            startedCommit = true
          } else {
            editor = 'closed'
          }
        } else if (editor === 'unknown') {
          const editingId =
            editingNoteIdRef.current
          if (
            editingId != null &&
            itemNotes.some(
              (note) => note.id === editingId,
            )
          ) {
            const note = itemNotes.find(
              (candidate) =>
                candidate.id === editingId,
            )!
            firstPassNote = note
            const draft =
              noteEditContentRef.current
            if (
              draft.trim() === '' ||
              draft === note.content
            ) {
              // Nothing to persist (an empty draft is never
              // PATCHed; an unchanged draft sends nothing):
              // close the editor and let the transition
              // proceed.
              cancelEditingNote()
              editor = 'closed'
            } else {
              // The single commit path; the next round settles
              // it.
              void saveNoteEdit(item, note)
              startedCommit = true
            }
          } else {
            editor = 'closed'
          }
        }

        if (composer === 'unknown') {
          if (
            noteComposerItemIdRef.current ===
            item.id
          ) {
            const draft =
              noteDraftContentRef.current
            if (draft.trim() === '') {
              cancelNoteComposer()
              composer = 'closed'
            } else {
              void submitNoteComposer(item)
              startedCommit = true
            }
          } else {
            composer = 'closed'
          }
        }

        if (!startedCommit) {
          return true
        }
      }

      // Pathological (drafts keep advancing while saves settle):
      // keep the drafts in the editor and do NOT complete the
      // topic.
      return false
    }

  const handleDoneItem = async (item: ApiMeetingItem) => {
    if (
      updatingItemId != null ||
      doneFlowInFlightRef.current
    ) {
      return
    }

    doneFlowInFlightRef.current = true
    setActionError(null)

    try {
      // A Done activation persists the item's MeetingNote state
      // FIRST (an in-flight save or an open editor/composer
      // draft); a failed persistence leaves the draft + the
      // inline error and does NOT complete the topic.
      const persisted =
        await ensureItemNotesPersisted(item)
      if (!persisted) {
        return
      }

      const sourceWasCurrent =
        meeting?.currentMeetingItemId === item.id
      // The Done button's "Saving…" busy state represents the
      // Done mutation itself; the Note persistence phase above
      // shows its own editor feedback (the button must keep its
      // geometry and label until the press is released).
      setUpdatingItemId(item.id)
      try {
        await markMeetingItemDone(item.id)
        await refreshAfterResolvingCurrent(
          item.id,
          sourceWasCurrent,
        )
      } catch (error) {
        setActionError(
          getErrorMessage(
            error,
            'Agenda item could not be marked done.',
          ),
        )
      }
    } finally {
      doneFlowInFlightRef.current = false
      setUpdatingItemId(null)
    }
  }

  // Always-fresh flow entry for the stable document listener
  // below (the listener is attached once; the ref tracks the
  // current render's closure).
  const doneFlowRef = useRef<(
    item: ApiMeetingItem,
  ) => void>(() => {})
  doneFlowRef.current = (item) => {
    void handleDoneItem(item)
  }

  // The pointer release that ends a Done activation runs the
  // captured intent — wherever the release lands. A release off
  // the button (the action row moved between mousedown and
  // mouseup, or the pointer was dragged away) delivers no click
  // to the button, and a release on a shifted button may lose
  // its click to the row: the flow must not depend on the click
  // at all. The ensuing pointer click (detail > 0) is then a
  // leftover of the same activation — the button's onClick skips
  // it; keyboard activations (detail 0) still run the flow from
  // the click.
  useEffect(() => {
    const onPointerUp = () => {
      const intent =
        doneIntentRef.current
      if (intent == null) {
        return
      }

      doneIntentRef.current = null
      doneFlowRef.current(intent)
    }

    const onPointerCancel = () => {
      // The gesture was cancelled by the system: the focus-out
      // autosave was deferred for it — run it now, exactly as a
      // plain focus-leave would have (the draft is never silently
      // dropped).
      const intent =
        doneIntentRef.current
      if (intent == null) {
        return
      }
      doneIntentRef.current = null
      noteSurfaceAutosaveRef.current(intent)
    }

    document.addEventListener(
      'pointerup',
      onPointerUp,
    )
    document.addEventListener(
      'pointercancel',
      onPointerCancel,
    )
    return () => {
      document.removeEventListener(
        'pointerup',
        onPointerUp,
      )
      document.removeEventListener(
        'pointercancel',
        onPointerCancel,
      )
    }
  }, [])

  const handleReopenItem = async (item: ApiMeetingItem) => {
    if (updatingItemId != null) return
    setUpdatingItemId(item.id)
    setActionError(null)
    try {
      await reopenMeetingItem(item.id)
      // Reopen corrects Outcome only. Refresh canonical item and Meeting
      // state while preserving the user's local Selected item exactly.
      await refreshItems()
      await refreshMeeting()
    } catch (error) {
      setActionError(
        getErrorMessage(error, 'Agenda item could not be reopened.'),
      )
    } finally {
      setUpdatingItemId(null)
    }
  }

  // Cancellation is a reversal: refresh canonical item + Meeting state
  // (server Current stays authoritative) but deliberately do NOT
  // reconcile/advance selection. The source remains Selected. The
  // preserved-target notice uses the destination captured from the
  // active schedule BEFORE the refresh clears it.
  const handleCancelFollowUpCompleted = useCallback(
    async (
      result: ApiCancelMeetingItemFollowUpResult,
    ) => {
      const destinationTitle =
        cancelFollowUpSourceItem?.followUpSchedule
          ?.targetMeetingTitle ?? 'the meeting'
      await refreshItems()
      await refreshMeeting()
      if (
        result.targetItemDisposition === 'preserved'
      ) {
        setPreservedFollowUpNotice(
          `Follow-up cancelled. The agenda item in ${destinationTitle} was kept because it had already been changed.`,
        )
      }
    },
    [cancelFollowUpSourceItem, refreshItems, refreshMeeting],
  )

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
      navigate(meetingsReturnDestination)
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
    setNoteError(null)
  }

  // Single persistence path for the composer draft. The
  // SYNCHRONOUS in-flight ref (not the batched state) is what
  // prevents a repeated blur — or the blur + "Create work item"
  // click pair within one tick — from issuing a second create for
  // the same draft. Resolves true when the content is persisted
  // (or there was nothing to persist), false on failure (the
  // draft and the inline error stay in the composer). The draft is
  // read from the always-fresh mirror so an awaited re-commit
  // (the Done flow) never resubmits a stale draft.
  const submitNoteComposer = (
    item: ApiMeetingItem,
  ): Promise<NoteCommitResult> => {
    const trimmed =
      noteDraftContentRef.current.trim()
    if (
      !trimmed ||
      composerCreateInFlightRef.current
    ) {
      return Promise.resolve({
        ok: true,
        kind: 'create',
        editorStillOpen: false,
        composerStillOpen:
          noteComposerItemIdRef.current ===
          item.id,
      })
    }

    composerCreateInFlightRef.current = true
    setCreatingNoteItemId(item.id)
    setNoteError(null)

    const promise = (async ():
      Promise<NoteCommitResult> => {
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
        // The quiet "Create work item" affordance recorded its
        // intent synchronously; only the successfully persisted
        // Note becomes the Work Item source (the canonical
        // sequence).
        if (
          composerWorkItemIntentRef.current ===
          item.id
        ) {
          composerWorkItemIntentRef.current = null
          openNoteWorkItem(item, created)
        }
        return {
          ok: true,
          kind: 'create',
          editorStillOpen: false,
          composerStillOpen: false,
        }
      } catch (error) {
        // Preserve the draft so the next focus-leave retries
        // without re-typing; the Work Item dialog needs a
        // persisted Note, so this attempt's intent is dropped.
        composerWorkItemIntentRef.current = null
        setNoteError(
          getErrorMessage(
            error,
            'Note could not be added.',
          ),
        )
        return {
          ok: false,
          kind: 'create',
          editorStillOpen: false,
          composerStillOpen: true,
        }
      } finally {
        composerCreateInFlightRef.current = false
        setCreatingNoteItemId(null)
      }
    })()

    noteCommitInFlightRef.current =
      {
        itemId: item.id,
        kind: 'create',
        promise,
      }
    void promise.finally(() => {
      if (
        noteCommitInFlightRef.current
          ?.itemId === item.id
      ) {
        noteCommitInFlightRef.current = null
      }
    })

    return promise
  }

  const cancelNoteComposer = () => {
    composerWorkItemIntentRef.current = null
    setNoteComposerItemId(null)
    setNoteDraftContent('')
    setNoteError(null)
  }

  // True while a Done activation is in progress for this item:
  // the Done button's pointerdown captured the intent BEFORE this
  // focus-out, so the combined commit + Done flow owns the draft.
  // The autosave must NOT run ahead of it: its status line would
  // land in the flow above the action row between mousedown and
  // mouseup and shift the Done button out from under the cursor
  // (the browser then delivers the click to the row, not the
  // button). The intent exists only during the live pointer
  // gesture: pointerdown captures it, and the gesture ALWAYS ends
  // with a pointerup or pointercancel (both consume/clear it), so
  // a captured intent can never be "stale" at blur time — and it
  // must not be tested against document.activeElement, which only
  // switches to the button AFTER the editor's blur has dispatched.
  const isDoneActivationFor = (
    item: ApiMeetingItem,
  ): boolean => {
    const intent = doneIntentRef.current
    return (
      intent != null &&
      intent.id === item.id
    )
  }

  // Autosave on focus-leave: a non-blank draft persists through the
  // existing create API and then displays in place; a whitespace-
  // only draft closes the composer without creating a record. A
  // create already in flight is never duplicated. A Done
  // activation DEFERS the commit to the Done flow (no state
  // update runs in the mousedown task, so the action row keeps its
  // geometry until after the click).
  const handleComposerBlur = (
    item: ApiMeetingItem,
  ) => {
    if (noteComposerItemId !== item.id) {
      return
    }

    if (composerCreateInFlightRef.current) {
      return
    }

    if (isDoneActivationFor(item)) {
      return
    }

    const trimmed = noteDraftContent.trim()
    if (trimmed === '') {
      cancelNoteComposer()
      return
    }

    void submitNoteComposer(item)
  }

  const handleComposerEscape = () => {
    cancelNoteComposer()
  }

  // Quiet "Create work item" below the writing surface: records the
  // intent synchronously and persists the Note FIRST through the
  // single composer path. If the focus-leave autosave already
  // started the create, the in-flight resolve opens the dialog via
  // the intent — the Note is created exactly once either way.
  const handleComposerWorkItem = (
    item: ApiMeetingItem,
  ) => {
    if (noteComposerItemId !== item.id) {
      return
    }
    if (noteDraftContent.trim() === '') {
      return
    }

    composerWorkItemIntentRef.current =
      item.id

    if (!composerCreateInFlightRef.current) {
      void submitNoteComposer(item)
    }
  }

  const startEditingNote = (
    note: ApiMeetingNote,
  ) => {
    // Only one Note enters edit mode at a time: an open editor's
    // draft is resolved (autosaved on focus-leave, or discarded
    // with Escape) before another Note can open, so a draft is
    // never silently overwritten.
    if (
      editingNoteId != null &&
      editingNoteId !== note.id
    ) {
      return
    }

    setEditingNoteId(note.id)
    setNoteEditContent(note.content)
    setNoteError(null)
  }

  const cancelEditingNote = () => {
    setEditingNoteId(null)
    setNoteEditContent('')
    setNoteError(null)
  }

  // Single persistence path for an edited Note. The result
  // carries whether the content was persisted AND whether the
  // editor stays open afterwards (a failure, or a NEWER draft
  // typed while the save was in flight) so the Done flow can
  // re-commit without a stale re-render. The draft is read from
  // the always-fresh mirror so an awaited re-commit never
  // resubmits a stale draft.
  const saveNoteEdit = (
    item: ApiMeetingItem,
    note: ApiMeetingNote,
  ): Promise<NoteCommitResult> => {
    const trimmed =
      noteEditContentRef.current.trim()
    // The in-flight check reads the synchronous ref, NOT the
    // `savingNoteId` state: right after an awaited commit
    // settles, this render closure's state still shows the save
    // as in flight, and the stale guard would swallow the
    // re-commit of a newer draft (the topic would stall with the
    // editor still open).
    const inFlight =
      noteCommitInFlightRef.current
    if (
      !trimmed ||
      (inFlight != null &&
        inFlight.itemId === item.id &&
        inFlight.kind === 'save')
    ) {
      return Promise.resolve({
        ok: true,
        kind: 'save',
        editorStillOpen:
          editingNoteIdRef.current ===
          note.id,
        composerStillOpen: false,
      })
    }

    setSavingNoteId(note.id)
    setNoteError(null)

    const promise = (async ():
      Promise<NoteCommitResult> => {
      try {
        const updated = await updateMeetingNote(
          note.id,
          { content: trimmed },
        )
        updateItemNotes(
          item.id,
          (item.notes ?? []).map((candidate) =>
            candidate.id === updated.id
              ? updated
              : candidate,
          ),
        )
        // Keystrokes typed while this save was in flight keep the
        // editor open with the NEWER draft (the just-saved content
        // is already in the list); a stale result never discards
        // it.
        if (
          noteEditContentRef.current.trim() ===
          trimmed
        ) {
          setEditingNoteId(null)
          setNoteEditContent('')
        }
        return {
          ok: true,
          kind: 'save',
          editorStillOpen:
            noteEditContentRef.current.trim() !==
            trimmed,
          composerStillOpen: false,
        }
      } catch (error) {
        // Keep the edited draft open with a quiet inline error;
        // the next focus-leave retries without re-typing.
        setNoteError(
          getErrorMessage(
            error,
            'Note could not be updated.',
          ),
        )
        return {
          ok: false,
          kind: 'save',
          editorStillOpen: true,
          composerStillOpen: false,
        }
      } finally {
        setSavingNoteId(null)
      }
    })()

    noteCommitInFlightRef.current =
      {
        itemId: item.id,
        kind: 'save',
        promise,
      }
    void promise.finally(() => {
      if (
        noteCommitInFlightRef.current
          ?.itemId === item.id
      ) {
        noteCommitInFlightRef.current = null
      }
    })

    return promise
  }

  // Autosave on focus-leave: changed content persists through the
  // existing update API; unchanged content sends nothing and
  // returns to display mode; a whitespace-only draft never
  // PATCHes (the API rejects empty Notes) and is NOT turned into a
  // delete — the editor stays open with a quiet error. A Done
  // activation DEFERS the commit to the Done flow (no state
  // update runs in the mousedown task, so the action row keeps its
  // geometry until after the click).
  const handleNoteEditBlur = (
    item: ApiMeetingItem,
    note: ApiMeetingNote,
  ) => {
    if (editingNoteId !== note.id) {
      return
    }

    if (savingNoteId != null) {
      return
    }

    if (isDoneActivationFor(item)) {
      return
    }

    const draft = noteEditContent
    const trimmed = draft.trim()

    if (trimmed === '') {
      setNoteError(
        'Note content must not be empty.',
      )
      return
    }

    if (draft === note.content) {
      cancelEditingNote()
      return
    }

    void saveNoteEdit(item, note)
  }

  const handleNoteEditEscape = () => {
    cancelEditingNote()
  }

  // Closes the delete confirmation and restores focus to the
  // trigger that opened it (a no-op if the trigger unmounted
  // with a successfully deleted Note).
  const closeNoteDeleteDialog = () => {
    setPendingDeleteNote(null)
    queueMicrotask(() => {
      noteDeleteReturnFocusRef.current?.focus()
    })
  }

  // While the delete confirmation is open: focus the Delete
  // confirmation (the user invoked a deliberate destructive
  // action — Enter confirms immediately), and Escape cancels
  // without deleting. No global Enter handling: Enter activates
  // whichever dialog button holds focus (native button behavior).
  useEffect(() => {
    if (pendingDeleteNote == null) {
      return
    }

    noteDeleteConfirmRef.current?.focus()

    const handleKeyDown = (
      event: KeyboardEvent,
    ) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setPendingDeleteNote(null)
        queueMicrotask(() => {
          noteDeleteReturnFocusRef.current?.focus()
        })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [pendingDeleteNote])

  // Tab / Shift+Tab containment for the two dialog buttons.
  const handleNoteDeleteTabTrap = (
    event: React.KeyboardEvent,
  ) => {
    if (
      event.key !== 'Tab' ||
      noteDeleteDialogRef.current == null
    ) {
      return
    }

    const focusable = Array.from(
      noteDeleteDialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled])',
      ),
    )
    if (focusable.length === 0) {
      return
    }

    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    const active =
      document.activeElement as HTMLElement | null

    if (event.shiftKey) {
      if (
        active === first ||
        !noteDeleteDialogRef.current.contains(active)
      ) {
        event.preventDefault()
        last.focus()
      }
    } else if (
      active === last ||
      !noteDeleteDialogRef.current.contains(active)
    ) {
      event.preventDefault()
      first.focus()
    }
  }

  const confirmDeleteNote = () => {
    if (
      pendingDeleteNote == null ||
      deletingNoteId != null ||
      noteDeleteInFlightRef.current
    ) {
      return
    }

    const note = pendingDeleteNote
    closeNoteDeleteDialog()

    noteDeleteInFlightRef.current = true
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
        if (noteError != null) {
          setNoteError(null)
        }
      } catch (error) {
        setActionError(
          getErrorMessage(
            error,
            'Note could not be deleted.',
          ),
        )
      } finally {
        noteDeleteInFlightRef.current = false
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
    setNoteError(null)
    setNoteWorkItemNote(note)
    setWorkItemSource(item)
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

  // Contextual-selection close for the linked Work Item inspector,
  // mirroring the established Project view contract (see
  // ProjectDetailPage's outside-click-close effect): while the
  // non-modal edit inspector is open, a click landing on a genuine
  // Meeting surface closes it — a click inside the inspector
  // (its `data-work-item-inspector-boundary` subtree) or on another
  // linked Work Item target never does.
  //
  // Registered on the CAPTURE phase for the same reason the Project
  // view uses it: the DOM is still intact when the check runs, so
  // an inspector interaction that mutates its own nodes (e.g. the
  // title turning into an input) is never misread as "outside".
  // The handler never calls stopPropagation/preventDefault, so
  // every control's own click handler still runs normally
  // afterward.
  //
  // No linked Work Item target carries `data-work-item-id` (that
  // marker is the Project Board/List/Overview contract), so the
  // only marker checked here is the boundary — and the close is
  // guarded: it only clears state that still belongs to the item
  // that was open when the listener ran. A click on another linked
  // Work Item queues a switch to the new item first; by the time
  // these functional updates apply, the guard no longer matches and
  // the inspector is left to show the newly opened item.
  useEffect(() => {
    if (inspectorWorkItemId == null) {
      return
    }

    const openItemId = inspectorWorkItemId
    const openProjectId =
      inspectorItem?.projectId ?? null

    function handleDocumentClickCapture(
      event: MouseEvent,
    ) {
      const target = event.target

      if (!(target instanceof Element)) {
        return
      }

      if (
        target.closest(
          '[data-work-item-inspector-boundary]',
        )
      ) {
        return
      }

      setInspectorWorkItemId((current) =>
        current === openItemId ? null : current,
      )
      setInspectorItem((current) =>
        current != null && current.id === openItemId
          ? null
          : current,
      )
      setInspectorProject((current) =>
        current != null &&
        current.id === openProjectId
          ? null
          : current,
      )
      setInspectorConfiguration((current) =>
        current != null ? null : current,
      )
      setInspectorAssignees((current) =>
        current.length > 0 ? [] : current,
      )
      setInspectorParentItems((current) =>
        current.length > 0 ? [] : current,
      )
    }

    document.addEventListener(
      'click',
      handleDocumentClickCapture,
      true,
    )

    return () => {
      document.removeEventListener(
        'click',
        handleDocumentClickCapture,
        true,
      )
    }
  }, [inspectorItem, inspectorWorkItemId])

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
        <div className="flex min-h-72 items-center justify-center rounded-xl border border-border-subtle bg-surface">
          <span className="material-symbols-outlined mr-2 animate-spin text-[20px] text-text-muted">
            refresh
          </span>

          <span className="text-sm text-text-muted">
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
          onClick={() => navigate(meetingsReturnDestination)}
          className="inline-flex items-center gap-2 text-sm font-medium text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          <span className="material-symbols-outlined text-[18px]">
            arrow_back
          </span>
          Meetings
        </button>

        <div
          role="alert"
          className="mt-6 flex min-h-64 flex-col items-center justify-center rounded-xl border border-border-subtle bg-surface px-6 py-10 text-center"
        >
          <span className="material-symbols-outlined text-[28px] text-danger">
            error
          </span>

          <h1 className="mt-3 text-lg font-semibold text-text">
            Meeting unavailable
          </h1>

          <p className="mt-1 text-sm text-text-muted">
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
  const canEditParticipants = canPrepare

  // Breadcrumb scope segment for the Live header: the Research
  // Group name for group Meetings, the Project name for Project
  // Meetings (user-facing terminology fallback while the Project
  // is still loading or when it cannot be read).
  const liveScopeName =
    meeting.scope === 'project'
      ? (project?.name ?? 'Project Meeting')
      : (activeResearchGroup?.name ?? 'Research Group Meeting')

  // Preparation-view section list: a user who may prepare
  // manages the full occurrence structure, including hidden
  // Sections (marked as such, so they stay unhidable-reachable);
  // everyone else sees only the visible agenda.
  const preparationSections = canPrepare
    ? sortedSections
    : visibleSections

  // Quiet inline section creation: an understated
  // "+ Add section" row that expands in place into a compact
  // name input (Enter creates, Escape / Cancel dismisses).
  // Same presentation vocabulary as the section-local
  // "+ Add topic" quick add; creation goes through the
  // canonical createMeetingSection path.
  const sectionCreationControl = sectionComposerOpen ? (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void handleAddSection()
      }}
      className="flex h-9 w-full items-center gap-2 rounded-md bg-surface-subtle px-2"
    >
      <input
        ref={sectionComposerInputRef}
        autoFocus
        type="text"
        value={newSectionName}
        onChange={(event) =>
          setNewSectionName(event.target.value)
        }
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closeSectionComposer()
          }
        }}
        placeholder="Section name"
        aria-label="New section name"
        className="h-7 min-w-0 flex-1 bg-transparent px-1.5 text-[15px] leading-[22px] text-text outline-none placeholder:text-text-muted"
      />

      <button
        type="submit"
        disabled={
          addingSection ||
          !newSectionName.trim()
        }
        className="h-7 shrink-0 rounded px-2 text-[13px] font-medium text-text outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-45"
      >
        {addingSection ? 'Adding…' : 'Add'}
      </button>

      <button
        type="button"
        onClick={closeSectionComposer}
        className="h-7 shrink-0 rounded px-2 text-[13px] font-medium text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
      >
        Cancel
      </button>
    </form>
  ) : (
    <button
      type="button"
      onClick={() =>
        setSectionComposerOpen(true)
      }
      className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs leading-[18px] text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
    >
      <span>+ Add section</span>
    </button>
  )
  // A persisted, unlinked Note may become a Work Item while the
  // Meeting is Live, and still after it is Completed — as long as
  // the current user can write the Meeting's scope (any member for
  // a group Meeting; owner/member for a project Meeting). The
  // action never edits the Note itself.
  const canCreateWorkFromNote =
    !isUpcoming &&
    (meeting.scope === 'group'
      ? true
      : project?.currentUserRole === 'owner' ||
        project?.currentUserRole === 'member')

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
  // A successful resolution that clears Current deliberately keeps
  // its source selected; a fresh Live load with no Current still
  // renders the calm no-current state.
  const liveSelectedItem = isLive
    ? sortedItems.find(
        (item) => item.id === selectedItemId,
      ) ??
      (meeting?.currentMeetingItemId != null
        ? liveCurrentItem ?? null
        : null)
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

  // Topic contributor: the item's creator resolved to a Meeting
  // participant's user (the API carries createdById only). Null
  // when the creator is not among the visible participants.
  const liveSelectedAuthor =
    liveSelectedItem != null
      ? participantUserById.get(
          liveSelectedItem.createdById,
        ) ?? null
      : null

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
      <h1 className="min-w-0 break-words text-[28px] leading-[34px] font-semibold text-text">
        {meeting.title}
      </h1>

      <span className="mt-1 inline-flex shrink-0 items-center gap-1 text-xs leading-4 font-medium text-text-muted">
        {/* Plain-unicode check: stable without an icon font. */}
        <span aria-hidden="true" className="select-none text-[14px]">✓</span>
        Completed
      </span>
    </>
  )

  const completedRecapMetaLine = isCompleted && (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] leading-5 text-text-muted">
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
    // The Completed view is one deliberate document: Back nav,
    // Header (incl. Reopen/More), Outcomes, the
    // Outcomes-to-Protocol divider, and the Protocol record all
    // share the exact 840px width, left aligned inside the
    // unchanged Workspace shell. Other Meeting states keep the
    // full page width.
    <div className="mx-auto w-full max-w-5xl px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
      <div
        className={
          isCompleted
            ? 'w-full max-w-[840px]'
            : isUpcoming
              ? 'w-full max-w-[880px]'
              : undefined
        }
      >
      {/* Header — the Upcoming preparation view carries its
          approved Stitch composition (breadcrumb, title row with
          the lifecycle actions, metadata row with the
          compact participant stack, and the Quick Add bar); the
          Live Meeting carries the approved compact Stitch
          composition in its own branch (breadcrumb
          Meetings / Group or Project / Title, the Live pill
          with the elapsed timer, the participant avatar stack,
          and the lifecycle / admin actions); Completed (and
          cancelled) keep the shared header. */}
      {isUpcoming ? (
        <div className="flex flex-col">
          {/* Breadcrumb */}
          <nav
            aria-label="Breadcrumb"
            className="mb-1.5 flex select-none items-center gap-1.5 text-[13px] leading-[18px] text-text-muted"
          >
            <button
              type="button"
              onClick={() => navigate('/meetings')}
              className="-mx-1 rounded px-1 outline-none transition hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
            >
              Meetings
            </button>

            {activeResearchGroup?.name && (
              <>
                <span aria-hidden="true" className="text-text-faded">
                  /
                </span>

                <span className="truncate">
                  {activeResearchGroup.name}
                </span>
              </>
            )}
          </nav>

          {/* Title row */}
          <div className="mb-2.5 mt-1 flex items-center justify-between gap-6">
            <h1 className="min-w-0 truncate text-2xl font-semibold leading-8 tracking-tight text-text">
              {meeting.title}
            </h1>

            <div className="flex shrink-0 items-center gap-2.5">
              {canManageLifecycle && (
                <button
                  type="button"
                  disabled={updatingMeeting}
                  onClick={() => void handleStartMeeting()}
                  className="flex items-center gap-1.5 rounded-md bg-action px-3.5 py-1.5 text-[13px] font-medium text-text-inverse shadow-xs outline-none transition hover:bg-action-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:opacity-60"
                >
                  <span aria-hidden="true" className="material-symbols-outlined text-[16px]">
                    play_arrow
                  </span>
                  Start meeting
                </button>
              )}

              {canAdministerMeeting && (
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
          </div>

          {/* Metadata row: date · time · context | participant
              stack · Add user */}
          <div className="mb-6 flex items-center gap-4 text-[13px] leading-[18px] text-text-muted">
            <div className="flex items-center gap-1.5">
              <span>
                {formatMeetingDayLabel(
                  meeting.scheduledAt,
                )}
              </span>

              <span aria-hidden="true">·</span>
              <span>
                {formatMeetingClock(meeting.scheduledAt)}
              </span>

              <span aria-hidden="true">·</span>
              <span>
                {meeting.scope === 'project'
                  ? 'Project Meeting'
                  : 'Research Group Meeting'}
              </span>
            </div>

            <span aria-hidden="true" className="text-text-faded">
              |
            </span>

            <div
              role="group"
              aria-label="Participants"
              className="flex items-center -space-x-1.5"
            >
              {sortedParticipants.slice(0, 4).map(
                (participant) => (
                  <span
                    key={participant.id}
                    title={getPersonName(participant.user)}
                    className="flex h-6 w-6 select-none items-center justify-center rounded-full bg-surface-muted text-[10px] font-medium text-text ring-2 ring-canvas"
                  >
                    {getInitials(participant.user)}
                  </span>
                ),
              )}

              {participants.length > 4 && (
                <span className="flex h-6 w-6 select-none items-center justify-center rounded-full bg-surface-subtle text-[10px] font-medium text-text-muted ring-2 ring-canvas">
                  +{participants.length - 4}
                </span>
              )}
            </div>

            {canEditParticipants && (
              <button
                type="button"
                onClick={toggleParticipantManagement}
                aria-expanded={managingParticipants}
                className="ml-[-4px] rounded text-[13px] font-medium text-accent-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
              >
                {managingParticipants ? 'Done' : 'Add user'}
              </button>
            )}
          </div>

          {/* Quick Add bar */}
          {canPrepare && (
            <div className="flex h-12 items-center justify-between rounded-lg border border-border-subtle bg-surface px-4 shadow-xs">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span aria-hidden="true" className="material-symbols-outlined text-[16px] text-text-muted">
                  add
                </span>

                <QuickAddSectionSelect
                  sections={visibleSections}
                  selectedId={
                    quickAddTargetSection?.id ?? null
                  }
                  onSelect={setQuickAddSectionId}
                  disabled={visibleSections.length === 0}
                />

                <div className="mx-1 h-4 w-[1px] shrink-0 bg-border-subtle" />

                <input
                  ref={topQuickAddInputRef}
                  type="text"
                  value={quickAddTitle}
                  disabled={
                    visibleSections.length === 0 ||
                    quickAddCreating
                  }
                  onChange={(event) =>
                    setQuickAddTitle(event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void handleQuickAddSubmit()
                    }

                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setQuickAddTitle('')
                    }
                  }}
                  placeholder="Add a topic…"
                  aria-label="Add a topic"
                  className="min-w-0 flex-1 bg-transparent pr-2 text-[13px] text-text outline-none placeholder:text-text-muted disabled:opacity-50"
                />
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <kbd className="select-none rounded border border-border-subtle bg-surface-subtle px-1.5 py-0.5 font-sans text-[11px] text-text-muted">
                  {isMacLike ? '⌘K' : 'Ctrl K'}
                </kbd>
              </div>
            </div>
          )}
        </div>
      ) : isLive ? (
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
          <nav
            aria-label="Breadcrumb"
            className="flex min-w-0 select-none items-center gap-1.5 text-[13px] leading-[18px] text-text-tertiary"
          >
            <button
              type="button"
              onClick={() => navigate('/meetings')}
              className="-mx-1 shrink-0 rounded px-1 outline-none transition hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
            >
              Meetings
            </button>

            <span aria-hidden="true">/</span>

            <span className="max-w-44 truncate">
              {liveScopeName}
            </span>

            <span aria-hidden="true">/</span>

            {/* The Meeting title stays the page's single level-1
                heading (page heading contract) while carrying the
                compact Stitch breadcrumb-title treatment. */}
            <h1 className="min-w-0 truncate text-[15px] font-semibold leading-[18px] text-text">
              {meeting.title}
            </h1>
          </nav>

          <span
            aria-hidden="true"
            className="hidden h-3.5 w-[1px] shrink-0 bg-border-subtle sm:block"
          />

          {/* Compact Live indicator + elapsed timer from the
              persisted startedAt (graceful when missing). */}
          <span
            role="status"
            className="flex shrink-0 items-center gap-1.5 rounded border border-border-subtle bg-surface-subtle px-2 py-0.5"
          >
            <span
              aria-hidden="true"
              className="material-symbols-outlined animate-pulse text-[14px] text-accent-text"
            >
              radio_button_checked
            </span>

            <span className="text-[13px] leading-[18px] text-text-muted">
              Live
              <LiveElapsedTimer
                startedAt={meeting.startedAt}
              />
            </span>
          </span>

          {participants.length > 0 && (
            <>
              <span
                aria-hidden="true"
                className="hidden h-3.5 w-[1px] shrink-0 bg-border-subtle sm:block"
              />

              {/* Participant avatar stack (actual participants)
                  with an overflow indicator. */}
              <div
                role="group"
                aria-label="Participants"
                className="flex shrink-0 items-center -space-x-1"
              >
                {sortedParticipants.slice(0, 4).map(
                  (participant) => (
                    <span
                      key={participant.id}
                      title={getPersonName(participant.user)}
                      className="flex h-6 w-6 select-none items-center justify-center rounded-full bg-surface-muted text-[11px] font-medium text-text ring-2 ring-canvas"
                    >
                      {getInitials(participant.user)}
                    </span>
                  ),
                )}

                {participants.length > 4 && (
                  <span
                    title={sortedParticipants
                      .slice(4)
                      .map((participant) =>
                        getPersonName(participant.user),
                      )
                      .join(', ')}
                    className="flex h-6 w-6 select-none items-center justify-center rounded-full bg-surface-subtle text-[10px] font-medium text-text-tertiary ring-2 ring-canvas"
                  >
                    +{participants.length - 4}
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          {canManageLifecycle && (
            <button
              type="button"
              disabled={updatingMeeting}
              onClick={() => void handleEndMeeting()}
              className={LIVE_CONTROL_DANGER}
            >
              End meeting
            </button>
          )}

          {canAdministerMeeting && (
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
      ) : (
        <>
      <nav>
        <button
          type="button"
          onClick={() => navigate(meetingsReturnDestination)}
          className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 font-medium text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface ${
            isCompleted
              ? 'text-[13px] leading-5'
              : 'text-sm'
          }`}
        >
          <span aria-hidden="true" className={`material-symbols-outlined ${isCompleted ? 'text-[16px]' : 'text-[18px]'}`}>
            arrow_back
          </span>
          Meetings
        </button>
      </nav>

      <header className={`${isCompleted ? 'mt-5' : 'mt-4'} flex flex-wrap items-start justify-between gap-x-8 gap-y-4`}>
        <div className="min-w-0 flex-1">
          {(completedRecapHeader || null) ?? (
            <h1 className="truncate text-3xl font-semibold tracking-tight text-text">
              {meeting.title}
            </h1>
          )}

          {(completedRecapMetaLine || null) ?? (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-text-muted">
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
              <p className="mt-1 text-xs leading-[18px] text-text-muted">
                {completedOutcomeCounts.join(' · ')}
              </p>
            )}
        </div>

        <div className={`flex shrink-0 items-center ${isCompleted ? 'gap-2' : 'gap-2.5'}`}>
          {/* The Live indicator and End meeting action live in
              the dedicated Live header branch above; this branch
              serves Completed (and cancelled) Meetings. */}
          {isCompleted && canManageLifecycle && (
            <button
              type="button"
              disabled={updatingMeeting}
              onClick={() => void handleReopenMeeting()}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] leading-[18px] font-medium text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[16px]">
                replay
              </span>
              Reopen meeting
            </button>
          )}

          {canAdministerMeeting && (
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
        </>
      )}
      {actionError && (
        <div
          role="alert"
          className="mt-5 rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger"
        >
          {actionError}
        </div>
      )}

      {/* Participants — the Upcoming resting layout carries
          the compact avatar stack + Add user in the header
          metadata row (approved design); the management
          panel below is the only dedicated participant
          surface. */}

      {managingParticipants && canEditParticipants && (
        <div className="mt-4 rounded-xl border border-border-subtle bg-surface-quiet p-4">
          <div className="min-w-0 flex-1">
            <label className="block">
              <span className="sr-only">
                Search people to add
              </span>

              <input
                data-participant-search
                type="text"
                value={participantQuery}
                onChange={(event) =>
                  setParticipantQuery(event.target.value)
                }
                placeholder="Type at least 2 characters…"
                className="h-9 w-full rounded-lg border border-border-control bg-surface px-3 text-sm text-text outline-none placeholder:text-text-muted focus:border-focus"
              />
            </label>

            {participantSearchActive && (
              <div
                aria-live="polite"
                className="mt-2 max-h-44 overflow-y-auto rounded-xl border border-border-default bg-surface shadow-lg"
              >
                {searchingParticipants ? (
                  <div className="flex items-center gap-2 px-4 py-3 text-sm text-text-muted">
                    <span
                      aria-hidden="true"
                      className="material-symbols-outlined animate-spin text-[18px]"
                    >
                      refresh
                    </span>
                    Searching…
                  </div>
                ) : participantSearchError ? (
                  <div
                    role="alert"
                    className="px-4 py-3 text-sm text-danger"
                  >
                    {participantSearchError}
                  </div>
                ) : availableParticipants.length > 0 ? (
                  <div className="divide-y divide-border-subtle">
                    {availableParticipants.map(
                      (candidate) => (
                        <button
                          key={candidate.id}
                          type="button"
                          disabled={addingParticipant}
                          onClick={() =>
                            void handleAddParticipant(
                              candidate,
                            )
                          }
                          className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[11px] font-semibold text-text">
                            {getInitials(candidate)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-text">
                              {getPersonName(candidate)}
                            </span>
                            <span className="block truncate text-xs text-text-muted">
                              @{candidate.username}
                            </span>
                          </span>
                          <span className="text-xs font-semibold text-accent-text">
                            Add
                          </span>
                        </button>
                      ),
                    )}
                  </div>
                ) : (
                  <div className="px-4 py-3 text-sm text-text-muted">
                    {participantCandidates.length > 0
                      ? 'All matching people are added.'
                      : 'No matching people found.'}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="mt-4 divide-y divide-border-subtle">
            {sortedParticipants.map((participant) => (
              <div
                key={participant.id}
                className="flex items-center gap-3 py-2.5"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[10px] font-semibold text-text">
                  {getInitials(participant.user)}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-text">
                    {getPersonName(participant.user)}
                  </div>

                  <div className="truncate text-xs text-text-muted">
                    @
                    {participant.user.username}
                  </div>
                </div>

                {canAdministerMeeting && (
                  <button
                    type="button"
                    aria-label={`Remove ${getPersonName(participant.user)}`}
                    disabled={
                      removingParticipantId === participant.id
                    }
                    onClick={() =>
                      void handleRemoveParticipant(participant)
                    }
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition hover:bg-danger-bg hover:text-danger disabled:opacity-45"
                  >
                    <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
                      close
                    </span>
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Live Meeting: Agenda rail | Current Item workspace */}
      {isLive ? (
        <div
          data-live-shell
          className="mt-8 flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-x-8"
        >
          {/* LEFT: Agenda navigation — the approved Stitch
              composition: quiet section labels over compact 32px
              topic rows in a ~280px column. */}
          <nav
            aria-label="Agenda"
            className="w-full shrink-0 lg:sticky lg:top-8 lg:w-[280px] lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-1"
          >
            {sortedSections.length === 0 ? (
              <p className="px-2 fg-type-nav-secondary text-text-muted">
                No agenda items yet.
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                {sortedSections.map((section) => {
                  const sectionItems =
                    itemsBySection.get(section.id) ?? []

                  return (
                    <div
                      key={section.id}
                      className={
                        !section.isVisible
                          ? 'opacity-50'
                          : undefined
                      }
                    >
                      {/* Quiet section label: full-contrast only
                          while the Section carries topics; empty
                          Sections stay visible with the muted
                          label and no placeholder text. */}
                      {/* Section label on the frozen Sidebar chrome
                          scale (10px / 600 / uppercase / wider
                          tracking), matching the global workspace
                          navigation; full vs empty Sections keep
                          their two-tone distinction. */}
                      <h3
                        className={
                          sectionItems.length > 0
                            ? 'mb-1 px-2 fg-type-nav-section-label text-text-muted'
                            : 'px-2 fg-type-nav-section-label text-text-tertiary'
                        }
                      >
                        {section.name}
                      </h3>

                      {sectionItems.length > 0 && (
                        <ul className="flex flex-col gap-0.5">
                          {sectionItems.map((item) => {
                            const statusMeta =
                              agendaStatusMeta(item.outcome)

                            const isCurrent =
                              item.id ===
                              meeting.currentMeetingItemId
                            const isSelected =
                              item.id === selectedItemId

                            // Outcome symbol color is a small,
                            // independent semantic signal: Done
                            // uses Success, Follow-up and Open
                            // stay neutral. When the Open item IS
                            // current, the Current accent signal
                            // wins.
                            const symbolClass = isCurrent &&
                            item.outcome ===
                              'not_discussed'
                              ? 'text-accent-text'
                              : item.outcome === 'done'
                                ? 'text-success-text'
                                : 'text-text-tertiary'

                            const rowClass = [
                              'relative flex h-7 w-full items-center gap-2 overflow-hidden rounded px-2 text-left outline-none transition-colors',
                              isCurrent || isSelected
                                ? 'bg-surface-hover'
                                : 'hover:bg-surface-hover',
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
                                  className={`${rowClass} focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus`}
                                >
                                  {/* Current (persisted) marker:
                                      the 2px accent left
                                      indicator. Selected stays
                                      neutral — accent is reserved
                                      for Current. */}
                                  {isCurrent && (
                                    <span
                                      aria-hidden="true"
                                      className="absolute inset-y-0 left-0 w-[2px] bg-accent"
                                    />
                                  )}

                                  <span
                                    aria-hidden="true"
                                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[14px] leading-none ${symbolClass}`}
                                  >
                                    {statusMeta.symbol}
                                  </span>

                                  <span
                                    className={`min-w-0 flex-1 truncate fg-type-nav-secondary ${item.outcome === 'done' ? 'text-text-muted' : isCurrent || isSelected ? 'text-text' : 'text-text-muted'} ${isSelected ? 'font-medium' : ''}`}
                                  >
                                    {item.title}
                                  </span>

                                  {isCurrent && (
                                    <span className="shrink-0 text-[11px] font-medium leading-none text-accent-text">
                                      Current
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

                      {/* Existing Live quick-add survives,
                          restyled into the navigation vocabulary
                          and shown only to Meeting collaborators
                          (the server remains authoritative). */}
                      {canManageLifecycle && (
                        creatingSectionId === section.id ? (
                          <form
                            data-quick-add-form={section.id}
                            onSubmit={(e) => {
                              e.preventDefault()
                              void handleCreateItemInSection(
                                section,
                                (
                                  sectionItemTitle[section.id] ??
                                  ''
                                ).trim(),
                              ).catch((error) => {
                                setActionError(
                                  getErrorMessage(
                                    error,
                                    'Agenda item could not be created.',
                                  ),
                                )
                              })
                            }}
                            className="mt-1.5 flex items-center gap-1.5 pl-2 pr-2"
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
                              className="h-7 min-w-0 flex-1 rounded border border-default bg-surface px-2 text-[13px] leading-[18px] text-text outline-none placeholder:text-text-tertiary focus:border-accent focus:ring-1 focus:ring-focus"
                            />

                            <button
                              type="submit"
                              disabled={
                                !(
                                  sectionItemTitle[section.id] ??
                                  ''
                                ).trim()
                              }
                              className={LIVE_AGENDA_ADD_ACTION}
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
                            className={`${LIVE_AGENDA_ADD_ACTION} mt-1.5`}
                          >
                            <span aria-hidden="true" className={LIVE_AGENDA_ADD_ICON}>
                              add
                            </span>
                            {sectionItems.length === 0
                              ? 'Add first item'
                              : 'Add item'}
                          </button>
                        )
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </nav>

          {/* RIGHT: the approved Stitch focus pane — the quiet
              sunken `surface-subtle` container (low-contrast
              border, 8px radius, 24px padding, ~460px minimum
              height) carrying the topic context, the canonical
              Markdown document, the item Notes, and the execution
              actions. The pane grows with long documents: no
              internal scroll region, no clamping. */}
          <main
            aria-label="Agenda item"
            className="min-w-0 flex-1"
          >
            <section
              data-live-focus-pane
              className="flex min-h-[460px] min-w-0 flex-col rounded-[8px] border border-border-subtle bg-surface-subtle p-6"
            >
            {liveSelectedItem != null ? (
              <>
                {/* Context row: "Section · x of y" (left) and the quiet
                    Make-current / return actions (right, only while the
                    viewed item is not the Meeting's current item).
                    Keeping them in the same row preserves the reading
                    order Context -> Document -> Notes. */}
                <div className="flex min-w-0 items-center gap-3">
                  <p className="min-w-0 truncate text-[13px] leading-[18px] text-text-tertiary">
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

                  {!liveSelectionIsCurrent ? (
                    <div className="ml-auto flex shrink-0 items-center gap-2">
                      {liveCurrentItem != null && (
                        <button
                          type="button"
                          onClick={handleReturnToCurrent}
                          className={`${LIVE_CONTROL_TERTIARY} px-2`}
                        >
                          <span
                            aria-hidden="true"
                            className={LIVE_CONTROL_ICON}
                          >
                            arrow_back
                          </span>
                          Return to current
                        </button>
                      )}

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
                          className={`${LIVE_CONTROL_SECONDARY} border-accent px-2 text-accent-text hover:bg-accent-subtle hover:text-accent-text`}
                        >
                          {updatingItemId ===
                          liveSelectedItem!.id ? (
                            <span
                              aria-hidden="true"
                              className={`${LIVE_CONTROL_ICON} animate-spin`}
                            >
                              refresh
                            </span>
                          ) : (
                            <span
                              aria-hidden="true"
                              className={LIVE_CONTROL_ICON}
                            >
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
                  ) : null}
                </div>

                {/* Topic contributor: avatar/initials + name with
                    the relative creation time; degrades to the
                    time alone when the creator is not a visible
                    participant. */}
                <div className="mt-2.5 flex min-w-0 items-center gap-2 text-[13px] leading-[18px] text-text-tertiary">
                  {liveSelectedAuthor != null && (
                    <span
                      aria-hidden="true"
                      className="flex h-5 w-5 shrink-0 select-none items-center justify-center rounded-full bg-surface-muted text-[10px] font-medium text-text-muted"
                    >
                      {getInitials(liveSelectedAuthor)}
                    </span>
                  )}
                  <span className="min-w-0 truncate">
                    {liveSelectedAuthor != null
                      ? `${getPersonName(liveSelectedAuthor)} · ${formatItemRelativeTime(liveSelectedItem.createdAt)}`
                      : formatItemRelativeTime(
                          liveSelectedItem.createdAt,
                        )}
                  </span>
                </div>

                {/* The canonical Markdown document — the topic
                    itself, rendered in full through the
                    established read-only renderer (no truncation,
                    no clamp, no internal scroll, no redundant
                    derived title above its own document). */}
                <div className="mt-4 min-w-0">
                  <TopicMarkdownDisplay
                    content={
                      liveSelectedItem.content
                    }
                  />
                </div>

                {/* Informational feedback after a cancellation that
                    preserved an edited target; cleared by selection
                    changes and the next full load. */}
                {preservedFollowUpNotice != null && (
                  <div
                    role="status"
                    className="mt-5 flex items-start gap-2 rounded-lg bg-surface-muted px-3 py-2 text-sm text-text"
                  >
                    <span
                      aria-hidden="true"
                      className="material-symbols-outlined mt-0.5 text-[16px] text-text-muted"
                    >
                      info
                    </span>
                    <span className="min-w-0">
                      {preservedFollowUpNotice}
                      <button
                        type="button"
                        onClick={() =>
                          setPreservedFollowUpNotice(null)
                        }
                        className="ml-2 text-xs font-medium text-text-muted outline-none transition hover:text-text focus-visible:underline"
                      >
                        Dismiss
                      </button>
                    </span>
                  </div>
                )}

                {/* Existing persistent Meeting Notes: content,
                    authoring, and Note -> Work Item all stay
                    exactly as before, scoped to THIS item. The
                    column sits below the topic document inside
                    the pane (the pane constrains the width). */}
                <div className="mt-5 w-full">
                  <p className="text-[13px] font-semibold leading-[18px] text-text-muted">
                    Notes
                  </p>
                  {(liveSelectedItem.notes ?? []).length >
                    0 ? (

                      <ul className="mt-2 space-y-5">
                        {(liveSelectedItem.notes ?? []).map(
                          (note) => (
                            <li
                              key={note.id}
                              // While editing, the Note sits directly
                              // on the Focus Pane surface (no gray
                              // hover panel around the editor); the
                              // subtle row hover stays available in
                              // the resting state.
                              className={
                                editingNoteId ===
                                note.id
                                  ? 'group/note relative px-2 py-1'
                                  : 'group/note relative rounded px-2 py-1 transition hover:bg-surface-hover'
                              }
                            >
                              {editingNoteId ===
                              note.id ? (
                                <NoteInlineEditor
                                  value={noteEditContent}
                                  ariaLabel={`Edit note on ${liveSelectedItem.title}`}
                                  savingLabel={
                                    savingNoteId === note.id
                                      ? 'Saving…'
                                      : null
                                  }
                                  error={noteError}
                                  onValueChange={
                                    setNoteEditContent
                                  }
                                  onCommitDraft={() =>
                                    handleNoteEditBlur(
                                      liveSelectedItem,
                                      note,
                                    )
                                  }
                                  onEscape={
                                    handleNoteEditEscape
                                  }
                                />
                              ) : (
                                <>
                                  {/* The persisted content itself is
                                      the editing entry point (the
                                      same direct-interaction
                                      philosophy as Meeting
                                      Preparation): click or
                                      keyboard activation opens the
                                      existing inline editor in
                                      place. The element stays a
                                      plain <p> — no form control —
                                      so the approved resting
                                      typography (size, leading,
                                      color, wrapping, menu
                                      clearance) is untouched by
                                      the global button font reset.
                                      Hover discovery is the
                                      existing row highlight plus
                                      the text cursor; keyboard
                                      focus gets the Live focus
                                      ring. The hover icons, the
                                      attribution line, and the
                                      linked Work Item card stay
                                      independent controls. */}
                                  <p
                                    role="button"
                                    tabIndex={0}
                                    aria-label={`Edit note on ${liveSelectedItem.title}: ${note.content}`}
                                    onClick={() =>
                                      startEditingNote(note)
                                    }
                                    onKeyDown={(
                                      event,
                                    ) => {
                                      if (
                                        event.key === 'Enter' ||
                                        event.key === ' '
                                      ) {
                                        event.preventDefault()
                                        startEditingNote(note)
                                      }
                                    }}
                                    className="whitespace-pre-wrap cursor-text rounded-md pr-16 text-sm leading-6 text-text outline-none transition focus-visible:ring-2 focus-visible:ring-focus"
                                  >
                                    {note.content}
                                  </p>

                                  <p className="mt-1 text-[11px] text-text-tertiary">
                                    {getPersonName(
                                      note.author,
                                    )}{' '}
                                    ·{' '}
                                    {formatNoteTime(
                                      note.createdAt,
                                    )}
                                  </p>

                                  {/* Linked work: compact relation
                                      card(s) directly beneath the
                                      exact source Note. The Note
                                      stays visually primary; the
                                      generated Work Item reads as a
                                      secondary linked entity that
                                      opens the shared inspector. */}
                                  {note.linkedWorkItem !=
                                    null && (
                                    <div>
                                      <NoteLinkedWorkCaption />

                                      <NoteLinkedWorkCard
                                        linked={note.linkedWorkItem}
                                        onOpen={(linked) =>
                                          openLinkedWorkInspector(
                                            linked,
                                          )
                                        }
                                      />

                                      {justLinkedNoteId ===
                                      note.id && (
                                        <p role="status" className="mt-1 text-[11px] font-medium text-success">
                                          Work item created
                                        </p>
                                      )}
                                    </div>
                                  )}

                                  {/* Note actions: compact
                                      hover/focus-only icons (no
                                      three-dot menu). Editing is
                                      the content itself; the row
                                      reveals a quiet Work Item
                                      icon (where permitted and not
                                      yet linked) and — in a Live
                                      Meeting — a small delete icon
                                      that keeps the existing
                                      confirmation flow.

                                      Both actions share one quiet
                                      icon-button geometry (the
                                      compact MenuTrigger treatment:
                                      28px, 4px radius, neutral
                                      hover surface) with 16px
                                      outline artwork. The artwork
                                      size is pinned by the local
                                      .fg-live-note-action-icon rule
                                      (MeetingDetailPage.css) — the
                                      external 24px
                                      .material-symbols-outlined
                                      default is unlayered and beats
                                      the Tailwind utilities layer.
                                      The group (top-0.5) centers
                                      on the Note's 24px first text
                                      line. */}
                                  {(isLive ||
                                  (canCreateWorkFromNote &&
                                  note.linkedWorkItem ==
                                  null)) && (
                                    <div className="absolute right-2 top-0.5 flex items-center gap-0.5 opacity-0 transition group-hover/note:opacity-100 focus-within:opacity-100">
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
                                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
                                        >
                                          <span aria-hidden="true" className="fg-live-note-action-icon material-symbols-outlined text-[16px]">
                                            playlist_add
                                          </span>
                                        </button>
                                      )}

                                      {isLive && (
                                        <button
                                          type="button"
                                          onClick={(event) => {
                                            noteDeleteReturnFocusRef.current =
                                              event.currentTarget
                                            setPendingDeleteNote(
                                              note,
                                            )
                                          }}
                                          aria-label={`Delete note: ${note.content}`}
                                          title="Delete note"
                                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-muted outline-none transition hover:bg-surface-hover hover:text-danger focus-visible:ring-2 focus-visible:ring-focus"
                                        >
                                          <span aria-hidden="true" className="fg-live-note-action-icon material-symbols-outlined text-[16px]">
                                            delete
                                          </span>
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </>
                              )}
                            </li>
                          ),
                        )}
                      </ul>
                  ) : null}

                  {/* Composer: only when explicitly open. */}
                  {noteComposerItemId ===
                  liveSelectedItem.id ? (
                    <div
                      className={
                        (liveSelectedItem.notes ?? [])
                          .length > 0
                          ? 'mt-6'
                          : 'mt-2'
                      }
                    >
                      {/* The SAME seamless editor as existing-Note
                          editing: a blank writing surface below the
                          persisted Notes. Focus-leave autosaves the
                          draft (whitespace-only drafts close without
                          creating); Escape discards; the quiet
                          "Create work item" action persists the Note
                          first and then opens the Work Item dialog. */}
                      <NoteInlineEditor
                        value={noteDraftContent}
                        placeholder="Add what came up during the discussion…"
                        ariaLabel={`Add note to ${liveSelectedItem.title}`}
                        savingLabel={
                          creatingNoteItemId ===
                          liveSelectedItem.id
                            ? 'Adding…'
                            : null
                        }
                        error={noteError}
                        onValueChange={
                          setNoteDraftContent
                        }
                        onCommitDraft={() =>
                          handleComposerBlur(
                            liveSelectedItem,
                          )
                        }
                        onEscape={
                          handleComposerEscape
                        }
                        workItemAction={{
                          label:
                            'Create work item',
                          disabled:
                            noteDraftContent.trim() ===
                              '' ||
                            creatingNoteItemId !==
                              null,
                          onClick: () =>
                            handleComposerWorkItem(
                              liveSelectedItem,
                            ),
                        }}
                      />
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
                      className={`${LIVE_CONTROL_TERTIARY} ${(liveSelectedItem.notes ?? []).length > 0 ? 'mt-6' : 'mt-2'} px-2`}
                    >
                      <span aria-hidden="true" className={LIVE_CONTROL_ICON}>
                        add
                      </span>
                      {(liveSelectedItem.notes ?? []).length >
                      0
                        ? 'Add note'
                        : 'Add note…'}
                    </button>
                  )}
                </div>

                {liveSelectedItem.followUpSchedule != null && (
                  <div className="mt-7 border-t border-border-subtle pt-4">
                    <div className="flex items-start gap-2 text-sm">
                      <span aria-hidden="true" className="material-symbols-outlined mt-0.5 text-[17px] text-text-muted">
                        event_repeat
                      </span>
                      <div>
                        <p className="font-medium text-text">
                          Scheduled for {liveSelectedItem.followUpSchedule.targetMeetingTitle} · {formatMeetingDateCompact(liveSelectedItem.followUpSchedule.targetMeetingScheduledAt)}
                        </p>
                        <p className="mt-0.5 text-xs text-text-muted">
                          {liveSelectedItem.followUpSchedule.targetMeetingSectionName}
                        </p>
                      </div>
                    </div>
                    {canManageLifecycle && (
                      <button
                        ref={cancelFollowUpTriggerRef}
                        type="button"
                        disabled={
                          updatingItemId ===
                            liveSelectedItem.id
                        }
                        onClick={() =>
                          setCancelFollowUpSourceItem(
                            liveSelectedItem,
                          )
                        }
                        aria-label={`Cancel follow-up for ${liveSelectedItem.title}`}
                        title="Cancel follow-up"
                        className={`${LIVE_CONTROL_SECONDARY} mt-3 ml-7`}
                      >
                        <span aria-hidden="true" className={`${LIVE_CONTROL_ICON} text-text-tertiary`}>
                          event_busy
                        </span>
                        Cancel follow-up
                      </button>
                    )}
                  </div>
                )}

                {/* Resolving actions stay bound to Current. Reopen is an
                    outcome-only correction on the selected Done item and
                    deliberately does not move Current or Selected. */}
                {(() => {
                  if (!canManageLifecycle) {
                    return null
                  }
                  const selectedOutcome: AgendaItemOutcome =
                    liveSelectedItem.outcome
                  const busy =
                    updatingItemId !== null &&
                    updatingItemId === liveSelectedItem.id
                  const canResolveCurrent =
                    liveSelectionIsCurrent &&
                    liveCurrentItem != null &&
                    liveSelectedItem.followUpSchedule == null
                  const canReopenSelected = selectedOutcome === 'done'

                  if (!canResolveCurrent && !canReopenSelected) {
                    return null
                  }

                  const statusMeta = AGENDA_STATUS_META[selectedOutcome]
                  const statusNode = (
                    <span
                      key="status"
                      className={[
                        'inline-flex h-7 items-center gap-1.5 rounded px-1 text-xs font-medium',
                        selectedOutcome === 'done'
                          ? 'text-success'
                          : 'text-text-muted',
                      ].join(' ')}
                    >
                      <span aria-hidden="true" className={LIVE_CONTROL_ICON}>
                        {selectedOutcome === 'done' ? 'check' : 'refresh'}
                      </span>
                      {statusMeta.label}
                    </span>
                  )

                  if (canReopenSelected) {
                    return (
                      <div className="mt-7 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-4">
                        {statusNode}
                        <button
                          key="reopen"
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void handleReopenItem(liveSelectedItem)
                          }
                          aria-label={`Reopen ${liveSelectedItem.title}`}
                          title="Reopen"
                          className={LIVE_CONTROL_SECONDARY}
                        >
                          {busy ? 'Reopening…' : 'Reopen'}
                        </button>
                        {canResolveCurrent && liveCurrentItem != null && (
                          <button
                            key="schedule"
                            ref={followUpTriggerRef}
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              setFollowUpSourceItem(liveCurrentItem)
                            }
                            aria-label={`Schedule follow-up for ${liveCurrentItem.title}`}
                            title="Schedule follow-up"
                            className={LIVE_CONTROL_SECONDARY}
                          >
                            <span aria-hidden="true" className={`${LIVE_CONTROL_ICON} text-text-tertiary`}>
                              event_repeat
                            </span>
                            Schedule follow-up
                          </button>
                        )}
                      </div>
                    )
                  }

                  if (!canResolveCurrent || liveCurrentItem == null) {
                    return null
                  }

                  const currentOutcome = liveCurrentItem.outcome
                  // Stable keys: the row swaps whole control
                  // sets per outcome (Done <-> Reopen <->
                  // Change to Done). Keying by identity makes
                  // React UNMOUNT a button whose action changes
                  // (a release-leftover click on the old Done
                  // node must not hit a repurposed Reopen node)
                  // and keeps genuinely continuous controls
                  // ("Schedule follow-up", the status label)
                  // mounted across the swap.
                  const scheduleAction = (
                    <button
                      key="schedule"
                      ref={followUpTriggerRef}
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setFollowUpSourceItem(liveCurrentItem)
                      }
                      aria-label={`Schedule follow-up for ${liveCurrentItem.title}`}
                      title="Schedule follow-up"
                      className={LIVE_CONTROL_SECONDARY}
                    >
                      <span aria-hidden="true" className={`${LIVE_CONTROL_ICON} text-text-tertiary`}>
                        event_repeat
                      </span>
                      Schedule follow-up
                    </button>
                  )

                  return (
                    <div className="mt-7 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-4">
                      {currentOutcome === 'follow_up' ? (
                        <>
                          {statusNode}
                          {scheduleAction}
                          {busy ? (
                            <button
                              key="changing"
                              type="button"
                              disabled
                              aria-label={`Changing ${liveCurrentItem.title} outcome`}
                              className={LIVE_CONTROL_SECONDARY}
                            >
                              <span aria-hidden="true" className={`${LIVE_CONTROL_ICON} animate-spin`}>
                                refresh
                              </span>
                              Saving…
                            </button>
                          ) : (
                            <button
                              key="change-to-done"
                              type="button"
                              onPointerDown={() => {
                                doneIntentRef.current =
                                  liveCurrentItem
                              }}
                              onClick={(
                                event,
                              ) => {
                                // Click fallback: the pointer
                                // flow already ran from the
                                // release; this click carries
                                // the activation only for a
                                // keyboard press (detail 0) or a
                                // lost pointerup (intent still
                                // set). A detail > 0 leftover is
                                // skipped (exactly once).
                                const intent =
                                  doneIntentRef.current
                                if (intent != null) {
                                  doneIntentRef.current = null
                                  void
                                    handleDoneItem(
                                      liveCurrentItem,
                                    )
                                  return
                                }
                                if (event.detail === 0) {
                                  void
                                    handleDoneItem(
                                      liveCurrentItem,
                                    )
                                }
                              }}
                              aria-label={`Change ${liveCurrentItem.title} to done`}
                              title="Change to Done"
                              className={`${LIVE_CONTROL_SECONDARY} text-text`}
                            >
                              <span aria-hidden="true" className={`${LIVE_CONTROL_ICON} text-text-tertiary`}>
                                check
                              </span>
                              Change to Done
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          {scheduleAction}
                          <button
                            key="done"
                            type="button"
                            disabled={busy}
                            onPointerDown={() => {
                              doneIntentRef.current =
                                liveCurrentItem
                            }}
                            onClick={(
                              event,
                            ) => {
                              // Click fallback: the pointer
                              // flow already ran from the
                              // release; this click carries the
                              // activation only for a keyboard
                              // press (detail 0) or a lost
                              // pointerup (intent still set). A
                              // detail > 0 leftover is skipped
                              // (exactly once).
                              const intent =
                                doneIntentRef.current
                              if (intent != null) {
                                doneIntentRef.current = null
                                void
                                  handleDoneItem(
                                    liveCurrentItem,
                                  )
                                return
                              }
                              if (event.detail === 0) {
                                void
                                  handleDoneItem(
                                    liveCurrentItem,
                                  )
                              }
                            }}
                            aria-label={`Mark ${liveCurrentItem.title} as done`}
                            title="Done"
                            className={LIVE_CONTROL_SUCCESS}
                          >
                            {busy ? (
                              <span aria-hidden="true" className={`${LIVE_CONTROL_ICON} animate-spin`}>
                                refresh
                              </span>
                            ) : (
                              <span aria-hidden="true" className={LIVE_CONTROL_ICON}>
                                check
                              </span>
                            )}
                            {busy
                              ? 'Saving…'
                              : 'Done'}
                          </button>
                        </>
                      )}
                    </div>
                  )
                })()}
              </>
            ) : (
              <div className="py-10">
                <p className="text-sm font-medium text-text">
                  No current item
                </p>

                {liveOpenItemCount > 0 && (
                  <p className="mt-1.5 max-w-72 text-sm text-text-muted">
                    Select an open agenda item to start
                    discussing it.
                  </p>
                )}
              </div>
            )}
            </section>
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
      /* Agenda / Protocol — the Upcoming preparation layout
          (approved Stitch design). Live and Completed render
          their own shells in the branches above. */
      <div className="flex w-full flex-col gap-8 pb-16">
        {preparationSections.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border-subtle px-6 py-12 text-center">
            <span aria-hidden="true" className="material-symbols-outlined text-[26px] text-text-muted">
              checklist
            </span>

            <p className="mt-3 text-sm font-medium text-text-muted">
              No agenda items yet.
            </p>

            {canPrepare && (
              <div className="mx-auto mt-4 w-full max-w-72">
                {sectionCreationControl}
              </div>
            )}
          </div>
        ) : (
          preparationSections.map((section) => {
            const sectionItems =
              itemsBySection.get(section.id) ?? []

            return (
                <section
                  key={section.id}
                  aria-label={section.name}
                  className="flex flex-col rounded-lg border border-border-subtle bg-surface px-4 pb-1.5 pt-4"
                >
                  {/* Section header */}
                  <div className="group/menu flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <h2 className="text-[15px] font-semibold leading-5 text-text">
                        {section.name}
                      </h2>

                      {sectionItems.length > 0 && (
                        <span className="text-[13px] leading-[18px] text-text-muted">
                          {sectionItems.length}
                        </span>
                      )}

                      {canPrepare &&
                        !section.isVisible && (
                          <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-text-muted">
                            hidden
                          </span>
                        )}
                    </div>

                    {canPrepare && (
                      <span className="-mr-1 flex items-center">
                        <MenuTrigger
                          preparation
                          compact
                          label={`Actions for section ${section.name}`}
                        >
                          {(_, close) => (
                            <>
                              <MenuItem
                                preparation
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
                                preparation
                                label="Move up"
                                icon="arrow_upward"
                                disabled={
                                  sortedSections[0]?.id ===
                                  section.id ||
                                  reorderingSections
                                }
                                onClick={() => {
                                  void handleMoveSection(section, -1)
                                  close()
                                }}
                              />

                              <MenuItem
                                preparation
                                label="Move down"
                                icon="arrow_downward"
                                disabled={
                                  sortedSections.at(-1)?.id ===
                                  section.id ||
                                  reorderingSections
                                }
                                onClick={() => {
                                  void handleMoveSection(section, 1)
                                  close()
                                }}
                              />

                              <MenuItem
                                preparation
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

                  {section.description && (
                    <p className="mb-1 mt-1 text-[13px] leading-[18px] text-text-muted">
                      {section.description}
                    </p>
                  )}

                  {/* Section edit form */}
                  {canPrepare &&
                    editingSectionId === section.id && (
                      <div className="mb-1 mt-2 rounded-lg border border-border-subtle bg-surface-quiet p-4">
                        <div className="flex flex-wrap items-end gap-3">
                          <label className="min-w-40 flex-1">
                            <span className="mb-1 block text-xs font-medium text-text-muted">
                              Name
                            </span>

                            <input
                              type="text"
                              aria-label="Name"
                              value={editSectionName}
                              onChange={(e) =>
                                setEditSectionName(e.target.value)
                              }
                              className="h-9 w-full rounded-lg border border-border-control bg-surface px-3 text-sm text-text outline-none focus:border-focus focus:ring-2 focus:ring-focus focus:ring-offset-2 focus:ring-offset-surface"
                            />
                          </label>

                          <label className="min-w-40 flex-1">
                            <span className="mb-1 block text-xs font-medium text-text-muted">
                              Description
                            </span>

                            <input
                              type="text"
                              aria-label="Description"
                              value={editSectionDescription}
                              onChange={(e) =>
                                setEditSectionDescription(e.target.value)
                              }
                              className="h-9 w-full rounded-lg border border-border-control bg-surface px-3 text-sm text-text outline-none focus:border-focus focus:ring-2 focus:ring-focus focus:ring-offset-2 focus:ring-offset-surface"
                            />
                          </label>

                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={savingSection}
                              onClick={() =>
                                void handleSaveSection(section)
                              }
                              className="h-9 rounded-lg bg-accent px-4 text-sm font-semibold text-text-inverse transition hover:bg-accent-hover disabled:opacity-45 outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                            >
                              {savingSection ? 'Saving…' : 'Save'}
                            </button>

                            <button
                              type="button"
                              onClick={() => setEditingSectionId(null)}
                              className="h-9 rounded-lg px-3 text-sm font-medium text-text-muted transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  {/* Items */}
                  <div className="flex flex-col">
                    {sectionItems.length === 0 && !canPrepare && (
                      <p className="px-2 py-1 text-[13px] leading-[18px] text-text-muted">
                        No agenda items yet.
                      </p>
                    )}

                    <ul className="flex flex-col">
                      {sectionItems.map((item) => {
                        const author =
                          participantUserById.get(
                            item.createdById,
                          )
                        const isEditingItem =
                          canPrepare &&
                          editingItemId === item.id

                        return (
                        <li key={item.id}>
                          {/* Unified inline Markdown: the SAME
                              composer for creation (below) and
                              editing (here) — the rendered topic is
                              the editing entry point, so there is no
                              separate edit card, popover, or
                              title / notes form. */}
                          {isEditingItem ? (
                            <div className="px-2 py-1.5">
                              <TopicMarkdownComposer
                                initialValue={item.content}
                                ariaLabel={`Edit topic ${item.title}`}
                                saving={
                                  savingItemId ===
                                  item.id
                                }
                                onSave={(content) =>
                                  handleSaveItem(
                                    item,
                                    content,
                                  )
                                }
                                onCancel={() =>
                                  setEditingItemId(
                                    null,
                                  )
                                }
                              />
                            </div>
                          ) : (
                            <div className="group/item flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-md px-2 py-1.5 transition hover:bg-surface-hover">
                              <span
                                aria-hidden="true"
                                className="material-symbols-outlined mt-[3px] w-4 shrink-0 cursor-grab select-none text-[14px] text-text-muted opacity-0 transition-opacity group-hover/item:opacity-100"
                              >
                                drag_indicator
                              </span>

                              {/* The ENTIRE saved topic, always
                                  visible: no truncation, no clamp,
                                  no internal scroll. For preparers
                                  the rendered content itself opens
                                  editing in place. */}
                              <div className="min-w-0 flex-1">
                                <TopicMarkdownDisplay
                                  content={item.content}
                                  onEdit={
                                    canPrepare
                                      ? () =>
                                          startEditingItem(
                                            item,
                                          )
                                      : undefined
                                  }
                                  editLabel={
                                    canPrepare
                                      ? `Edit topic ${item.title}`
                                      : undefined
                                  }
                                />
                              </div>

                              <div className="flex shrink-0 items-center gap-2">
                                {/* Attribution: always visible, at rest
                                    and on row hover/focus alike. */}
                                <div className="flex w-[200px] shrink-0 items-center justify-start gap-2 text-[13px] leading-[18px] text-text-muted">
                                  {author && (
                                    <span className="flex h-5 w-5 shrink-0 select-none items-center justify-center rounded-full bg-surface-muted text-[10px]">
                                      {getInitials(author)}
                                    </span>
                                  )}

                                  <span className="min-w-0 truncate">
                                    {author
                                      ? `${getPersonName(author)} · ${formatItemRelativeTime(item.createdAt)}`
                                      : formatItemRelativeTime(item.createdAt)}
                                  </span>
                                </div>

                                {/* Reserved action zone: owns its own
                                    space next to the attribution (never
                                    overlays it) and stays quiet until
                                    the row is hovered or focused. */}
                                {canPrepare && (
                                  <span className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/item:opacity-100 group-focus-within/item:opacity-100">
                                    <MenuTrigger
                                      preparation
                                      compact
                                      label={`Actions for agenda item ${item.title}`}
                                    >
                                      {(_, close) => (
                                        <>
                                          {/* Editing is DIRECT: the
                                              rendered topic is the
                                              entry point, so the menu
                                              no longer carries a
                                              redundant Edit action. */}
                                          <MenuItem
                                            preparation
                                            label="Create work item"
                                            icon="add_task"
                                            onClick={() => {
                                              setWorkItemSource(item)
                                              close()
                                            }}
                                          />

                                          {item.workItemIds.length >
                                            0 && (
                                            <MenuItem
                                              preparation
                                              disabled
                                              icon="task_alt"
                                              label={`${item.workItemIds.length} linked work ${item.workItemIds.length === 1 ? 'item' : 'items'}`}
                                              onClick={() => {}}
                                            />
                                          )}

                                          {(item.outcome === 'done' ||
                                            item.outcome === 'follow_up') && (
                                            <MenuItem
                                              preparation
                                              disabled
                                              icon={
                                                item.outcome === 'done'
                                                  ? 'check_circle'
                                                  : 'followup'
                                              }
                                              label={
                                                item.outcome === 'done'
                                                  ? 'Done'
                                                  : 'Follow-up'
                                              }
                                              onClick={() => {}}
                                            />
                                          )}

                                          <span role="none" className="my-1 border-t border-border-subtle" />

                                          <MenuItem
                                            preparation
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
                        )
                      })}
                    </ul>

                    {/* Section-local quick add: "+ Add topic" opens
                        the unified Markdown composer in place (one
                        multiline field — no title / notes form).
                        Adding a topic is Meeting collaboration
                        (the canonical MEETING_WRITE rule), so the
                        affordance renders only for users who may
                        prepare. */}
                    {canPrepare && creatingSectionId === section.id ? (
                      <div className="px-2 py-1.5">
                        <TopicMarkdownComposer
                          initialValue=""
                          ariaLabel={`Add a topic to ${section.name}`}
                          saving={creatingItem}
                          onSave={async (content) => {
                            // Client-side mirror of the server's
                            // authoritative MEETING_WRITE check:
                            // never submit an unauthorized create.
                            if (!canPrepare) {
                              return
                            }

                            setCreatingItem(true)

                            try {
                              await handleCreateItemInSection(
                                section,
                                content,
                              )
                            } finally {
                              setCreatingItem(false)
                            }
                          }}
                          onCancel={() =>
                            setCreatingSectionId(null)
                          }
                        />
                      </div>
                    ) : canPrepare ? (
                      <button
                        type="button"
                        onClick={() => {
                          setCreatingSectionId(section.id)
                          setSectionItemTitle((current) => ({
                            ...current,
                            [section.id]: '',
                          }))
                        }}
                        className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] leading-[18px] text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        <span aria-hidden="true" className="material-symbols-outlined w-4 shrink-0 select-none text-[14px] opacity-0">
                          drag_indicator
                        </span>

                        <span>+ Add topic</span>
                      </button>
                    ) : null}
                  </div>
                </section>
            )
          })
        )}

        {/* Inline section creation directly below the final
            section. */}
        {canPrepare && preparationSections.length > 0 && (
          <div className="-mt-4">
            {sectionCreationControl}
          </div>
        )}
      </div>
      )}

      <MeetingFollowUpSchedulingDialog
        sourceItem={isLive ? followUpSourceItem : null}
        returnFocusRef={followUpTriggerRef}
        onClose={() => setFollowUpSourceItem(null)}
        onScheduled={async () => {
          const sourceItem = followUpSourceItem
          if (sourceItem == null) return
          const sourceWasCurrent =
            meeting?.currentMeetingItemId === sourceItem.id
          await refreshAfterResolvingCurrent(
            sourceItem.id,
            sourceWasCurrent,
          )
        }}
      />

      <MeetingCancelFollowUpDialog
        sourceItem={
          isLive ? cancelFollowUpSourceItem : null
        }
        returnFocusRef={cancelFollowUpTriggerRef}
        onClose={() => setCancelFollowUpSourceItem(null)}
        onCancelled={handleCancelFollowUpCompleted}
      />

      {deleteDialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-scrim px-4 py-8 backdrop-blur-[2px]"
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
            className="w-full max-w-md overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-xl"
          >
            <div className="px-6 py-5">
              <h2
                id="meeting-delete-title"
                className="text-lg font-semibold tracking-tight text-text"
              >
                Delete meeting?
              </h2>

              <p className="mt-2 text-sm text-text-muted">
                This permanently deletes this meeting and its
                agenda/protocol content. Work Items created from this
                meeting will not be deleted.
              </p>

              {actionError && (
                <p
                  role="alert"
                  className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger"
                >
                  {actionError}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-border-subtle px-6 py-4">
              <button
                type="button"
                disabled={deletingMeeting}
                onClick={() => setDeleteDialogOpen(false)}
                className="inline-flex h-9 items-center rounded-lg px-3.5 text-sm font-medium text-text-muted outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus/40 disabled:opacity-60"
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={deletingMeeting}
                onClick={() => void handleDeleteMeeting()}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-danger-subtle px-3.5 text-sm font-semibold text-danger outline-none transition hover:bg-danger-bg focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 disabled:opacity-60"
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-scrim px-4 py-8 backdrop-blur-[2px]"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget &&
              deletingNoteId == null
            ) {
              closeNoteDeleteDialog()
            }
          }}
        >
          <div
            ref={noteDeleteDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="note-delete-title"
            aria-describedby="note-delete-description"
            onKeyDown={handleNoteDeleteTabTrap}
            className="w-full max-w-md overflow-hidden rounded-2xl border border-border-structural bg-surface shadow-xl"
          >
            <div className="px-6 py-5">
              <h2
                id="note-delete-title"
                className="text-lg font-semibold tracking-tight text-text"
              >
                Delete note?
              </h2>

              <p
                id="note-delete-description"
                className="mt-2 text-sm text-text-muted"
              >
                This permanently deletes the note. The agenda item
                and any linked Work Items are not affected.
              </p>

              {actionError && (
                <p
                  role="alert"
                  className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger"
                >
                  {actionError}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-border-subtle px-6 py-4">
              <button
                type="button"
                disabled={deletingNoteId != null}
                onClick={closeNoteDeleteDialog}
                className="inline-flex h-9 items-center rounded-lg px-3.5 text-sm font-medium text-text-muted outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus/40 disabled:opacity-60"
              >
                Cancel
              </button>

              <button
                ref={noteDeleteConfirmRef}
                type="button"
                disabled={deletingNoteId != null}
                onClick={() => void confirmDeleteNote()}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-danger px-3.5 text-sm font-semibold text-text-inverse outline-none transition hover:bg-danger/80 focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60"
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
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-soft-scrim">
            <div className="flex items-center gap-2 rounded-xl border border-border-subtle bg-surface px-5 py-4 text-sm text-text-muted shadow-xl">
              <span aria-hidden="true" className="material-symbols-outlined animate-spin text-[18px]">
                refresh
              </span>
              Opening work item…
            </div>
          </div>
        )
      )}
      </div>
    </div>
  )
}
