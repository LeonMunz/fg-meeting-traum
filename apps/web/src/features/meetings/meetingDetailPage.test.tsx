import { beforeAll, describe, expect, it } from 'vitest'

import { AGENDA_STATUS_META } from './agendaStatus'
import { MeetingDetailPage } from './MeetingDetailPage'

const MEETING_DETAIL_SOURCE =
  MeetingDetailPage.toString()

describe('MeetingDetailPage lifecycle semantics', () => {
  it('exposes Start meeting for upcoming meetings', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('Start meeting')
  })

  it('keeps End meeting for live meetings', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('End meeting')
  })

  it('keeps Reopen meeting for completed meetings', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('Reopen meeting')
  })
})

describe('MeetingDetailPage status-aware content', () => {
  it('does not render the legacy open/discussed toggle', () => {
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'item.status === "open"',
    )
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'item.status === "discussed"',
    )
  })

  it('derives the current item from the persisted Meeting pointer', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'item.id === meeting.currentMeetingItemId',
    )
    // Outcome is the only persisted MeetingItem state.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'item.outcome',
    )
  })

  it('exposes canonical Focus, Done and follow-up scheduling actions', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('handleFocusItem')
    expect(MEETING_DETAIL_SOURCE).toContain('handleDoneItem')
    expect(MEETING_DETAIL_SOURCE).toContain(
      'setFollowUpSourceItem',
    )
  })
})

describe('MeetingDetailPage section and item controls', () => {
  it('exposes section secondary actions through a menu', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('Rename / describe')
    expect(MEETING_DETAIL_SOURCE).toContain('Hide section')
    expect(MEETING_DETAIL_SOURCE).toContain('Move up')
    expect(MEETING_DETAIL_SOURCE).toContain('Move down')
  })

  it('exposes item secondary actions through a menu', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('Create work item')
    expect(MEETING_DETAIL_SOURCE).toContain('Delete')
  })

  it('creates sections inline below the section list (no structure mode)', () => {
    // Section creation is a quiet inline action: a subtle
    // "+ Add section" row expands in place into a compact
    // name input over the canonical creation API.
    expect(MEETING_DETAIL_SOURCE).toContain('+ Add section')
    expect(MEETING_DETAIL_SOURCE).toContain('New section name')
    expect(MEETING_DETAIL_SOURCE).toContain(
      'handleAddSection',
    )
    // The separate structure-editing mode is gone.
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'Edit structure',
    )
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'structureEditing',
    )
  })

  it('supports inline quick-add for agenda items', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('Add item')
  })
})

describe('MeetingDetailPage participant surface', () => {
  it('renders a compact participant context with explicit manage state', () => {
    // The approved design carries the compact participant stack +
    // the "Add user" text link in the header metadata row (no icon);
    // the management panel stays behind the managing state.
    expect(MEETING_DETAIL_SOURCE).toContain('Participants')
    expect(MEETING_DETAIL_SOURCE).toContain('Add user')
    expect(MEETING_DETAIL_SOURCE).toContain(
      'setManagingParticipants',
    )
  })

  it('keeps participant add/remove behind the management state', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'managingParticipants && canEditParticipants',
    )
  })
})

describe('MeetingDetailPage Work Item integration', () => {
  it('keeps the canonical Meeting -> Work Item dialog', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'CreateMeetingWorkItemDialog',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'setWorkItemSource(item)',
    )
  })
})

describe('MeetingDetailPage status gating', () => {
  it('gates preparation controls to upcoming + lifecycle permission', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'const canPrepare = isUpcoming && canManageLifecycle',
    )
  })
})

describe('MeetingDetailPage agenda item deletion', () => {
  it('deletes through the canonical typed API adapter', () => {
    // The deletion goes through the shared CSRF-aware API
    // client (apps/web/src/api/meetings.ts → apiDelete →
    // DELETE /api/meeting-items/{id}/). A raw fetch to the
    // unregistered legacy URL was the original false-success
    // defect: this pins that it never comes back.
    // Asserted on the transpiled call shape: the captured source
    // is post-module-transformation, so the import is emitted as
    // `(0, __vite_ssr_import_N__.deleteMeetingItem)(item.id)`.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'deleteMeetingItem)(item.id)',
    )
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'meetings/items/',
    )
  })

  it('guards against duplicate in-flight deletions', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'deleteItemInFlightRef',
    )
  })
})

describe('MeetingDetailPage persistent Meeting Notes', () => {
  it('does not keep a second permanent frontend Note truth', () => {
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'temporaryNotes',
    )
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'localStorage',
    )
  })

  it('renders persisted Notes in Live and Completed', () => {
    // Live: the item-detail pane renders the SELECTED (viewed)
    // item's Notes; Completed: the recap document renders them
    // from the same canonical items payload
    // (CompletedMeetingRecap, a separate component). The redesigned
    // Upcoming compact row intentionally carries no notes block.
    expect(MEETING_DETAIL_SOURCE).toContain(
      '(liveSelectedItem.notes ?? []).length >',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'CompletedMeetingRecap',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'Notes',
    )
  })

  it('gates Note authoring to Live meetings', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'Add note…',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'createMeetingNote',
    )
  })

  it('edits Notes through the shared seamless inline editor (no input box)', () => {
    // The Live Note edit mode renders the shared borderless,
    // auto-growing NoteInlineEditor…
    expect(MEETING_DETAIL_SOURCE).toContain(
      'NoteInlineEditor',
    )
    // …and the old boxed editor (border + panel background +
    // input padding) is gone from the Note branch.
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'bg-surface px-2 py-1.5 text-sm',
    )
  })
})

describe('MeetingDetailPage Live Meeting shell', () => {
  // NOTE: these assertions run against the transpiled function
  // source (JSX -> React.createElement), so they match stable
  // substrings that survive transpilation rather than raw JSX.

  it('switches to the Live shell only for live meetings', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      "const isLive = meeting.status === \"live\";",
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      '"data-live-shell": true',
    )
  })

  it('renders an Agenda rail beside the viewed-item detail pane', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      '"aria-label": "Agenda"',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      '"aria-label": "Agenda item"',
    )
  })

  it('derives the current item from the persisted Meeting pointer', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'meeting.currentMeetingItemId',
    )
  })

  it('shows the Section name and section-relative position', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'liveSelectedSection?.name',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'liveSelectedPosition',
    )
  })

  it('renders every MeetingItem outcome with symbol and accessible text', () => {
    // Every outcome exposes a symbol AND an accessible text label,
    // so the symbol alone is never the only signal. "Discussing"
    // is not an outcome; current is derived from the Meeting.
    expect(AGENDA_STATUS_META.done.symbol).toBe('✓')
    expect(AGENDA_STATUS_META.done.label).toBe('Done')
    expect(AGENDA_STATUS_META.follow_up.symbol).toBe('↻')
    expect(AGENDA_STATUS_META.follow_up.label).toBe('Follow-up')
    expect(AGENDA_STATUS_META.not_discussed.symbol).toBe('○')
    expect(AGENDA_STATUS_META.not_discussed.label).toBe(
      'Not discussed',
    )
    // The Agenda rail renders an sr-only status hint next to
    // every symbol.
    expect(MEETING_DETAIL_SOURCE).toContain('sr-only')
    expect(MEETING_DETAIL_SOURCE).toContain(
      'statusMeta.hint',
    )
  })

  it('keeps every Section and item visible in the Agenda rail', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'sortedSections.map((section) => {',
    )
    // Empty Sections stay visible (the muted label), without
    // any placeholder text.
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      '"No items"',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'sectionItems.map((item) => {',
    )
  })

  it('wires the Live Agenda rail to local selection only (no Focus / make-current control)', () => {
    // STALE TEST (updated): the Live rail used to offer a Focus
    // (make-current) button. That affordance is deferred to the
    // "Make current" slice, so the Live row is a pure selection
    // control and the Live rail region must not reference the
    // Focus action. (The rendered no-Focus behavior is asserted in
    // meetingLiveSelection.test.tsx.)
    expect(MEETING_DETAIL_SOURCE).toContain(
      'handleSelectLiveItem(item)',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'aria-pressed',
    )
    // The workspace pane that follows the rail list is labelled
    // for the viewed (selected) item, not "Current item". (The
    // transpiled function source renders JSX attributes as
    // `aria-label": "…"`, so match the transpiled form.)
    expect(MEETING_DETAIL_SOURCE).toContain(
      'aria-label": "Agenda item"',
    )
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'aria-label": "Current item"',
    )
  })

  it('keeps Done and Schedule follow-up on the current item', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'void handleDoneItem(liveCurrentItem)',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'setFollowUpSourceItem(liveCurrentItem)',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      '`Mark ${liveCurrentItem.title} as done`',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      '`Schedule follow-up for ${liveCurrentItem.title}`',
    )
  })

  it('renders a calm no-current-item state without inventing state', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'No current item',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'Select an open agenda item to start',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'liveOpenItemCount',
    )
  })

  it('keeps existing Note authoring and Note -> Work Item on the viewed item', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      '`Add note to ${liveSelectedItem.title}`',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'openNoteComposer(liveSelectedItem)',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'openNoteWorkItem(',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'openLinkedWorkInspector(',
    )
  })

  it('does not couple Live Note authoring to lifecycle management', () => {
    // Pre-refactor behavior: Live Note authoring (composer, edit,
    // delete, Add note trigger) was gated on `isLive` alone — any
    // user the backend authorizes for Meeting Note writes can
    // author. Lifecycle management (Start / End / Reopen) is a
    // separate permission and must not gate the composer.
    // Composer open state is gated on the composer state only.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'noteComposerItemId === liveSelectedItem.id',
    )
    // Note edit mode is gated on the edit state only.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'editingNoteId === note.id',
    )
    // Add-note trigger is Live-only (no lifecycle coupling).
    expect(MEETING_DETAIL_SOURCE).toContain(
      'isLive && noteComposerItemId !== liveSelectedItem.id',
    )
    // Per-note Edit/Delete menu is Live-only, as before the
    // refactor. (Matched against the stable transpiled call
    // shape, not a hardcoded esbuild import index.)
    expect(MEETING_DETAIL_SOURCE).toContain(
      'isLive && /* @__PURE__ */ (0,',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      '.jsxDEV)(MenuTrigger',
    )
    // The Current Item workspace must not render a composer,
    // edit mode, trigger, or note menu behind
    // canManageLifecycle.
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'canManageLifecycle && noteComposerItemId',
    )
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'canManageLifecycle && editingNoteId',
    )
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'canManageLifecycle && (0, __vite_ssr_import',
    )
  })

  it('keeps the Live quick-add under every Agenda Section', () => {
    // The Live rail renders the same inline quick-add composer.
    expect(MEETING_DETAIL_SOURCE).toContain(
      '"data-quick-add-form": section.id',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      '`Add item to ${section.name}`',
    )
  })

  it('shows the Live state in the header without a duplicate current item title', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      '"Live"',
    )
    // The Live focus pane renders the canonical Markdown
    // document itself — no separate derived-title heading above
    // it (that would repeat the document's opening line).
    expect(MEETING_DETAIL_SOURCE).toContain(
      'TopicMarkdownDisplay',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'content: liveSelectedItem.content',
    )
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'data-current-item-title',
    )
  })

  it('renders the approved Stitch focus pane container', () => {
    // The Live right column is one quiet semantic surface with a
    // low-contrast border, 8px radius, 24px padding, ~460px minimum
    // height, and no shadow.
    expect(MEETING_DETAIL_SOURCE).toContain(
      '"data-live-focus-pane": true',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'flex min-h-[460px] min-w-0 flex-col rounded-[8px] border border-border-subtle bg-surface-subtle p-6',
    )
    // The pane must never introduce an internal scroll region or
    // decorative shadow (the document grows the pane instead).
    const paneClass =
      'flex min-h-[460px] min-w-0 flex-col rounded-[8px] border border-border-subtle bg-surface-subtle p-6'
    expect(paneClass).not.toContain('shadow')
    expect(paneClass).not.toContain('overflow')
  })

  it('resolves the topic contributor from the Meeting participants', () => {
    // The API carries createdById only; the creator is resolved
    // against the visible participants and shown with the
    // relative creation time (graceful fallback to the time
    // alone when unresolved).
    expect(MEETING_DETAIL_SOURCE).toContain(
      'liveSelectedAuthor',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'getInitials(liveSelectedAuthor)',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'formatItemRelativeTime(liveSelectedItem.createdAt)',
    )
  })
})

describe('MeetingDetailPage Live visual polish', () => {
  it('confines participant management to the Upcoming preparation state', () => {
    // The standalone participant context surface is gone (the
    // header metadata row carries the compact stack + Manage); the
    // management panel can only open in the Upcoming preparation
    // state because canEditParticipants is canPrepare itself.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'const canEditParticipants = canPrepare',
    )
  })

  it('keeps the participant count in the header metadata line', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'participants.length === 1',
    )
    expect(MEETING_DETAIL_SOURCE).toContain('"participant"')
    expect(MEETING_DETAIL_SOURCE).toContain('"participants"')
  })

  it('renders End meeting as a restrained destructive action', () => {
    // End meeting keeps its behavior (handleEndMeeting) and is
    // offered to lifecycle managers through the shared compact
    // family: quiet bordered, semantic Danger text, and no fill.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'void handleEndMeeting()',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'canManageLifecycle && (',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'className: LIVE_CONTROL_DANGER',
    )
  })

  it('renders existing Notes before the Add-note composer', () => {
    // The existing-notes block must appear before the open-composer
    // conditional in the Current Item workspace source.
    const notesBlock = MEETING_DETAIL_SOURCE.indexOf(
      '(liveSelectedItem.notes ?? []).length >',
    )
    // The open composer is keyed on the composer state; the
    // closed-state trigger is keyed on the negation of that same
    // state.
    const composer = MEETING_DETAIL_SOURCE.indexOf(
      'noteComposerItemId === liveSelectedItem.id',
    )
    expect(notesBlock).toBeGreaterThan(-1)
    expect(composer).toBeGreaterThan(-1)
    expect(notesBlock).toBeLessThan(composer)
  })

  it('keeps the Add-note composer openable and quiet when closed', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'openNoteComposer(liveSelectedItem)',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'isLive && noteComposerItemId !== liveSelectedItem.id',
    )
  })

  it('keeps Live Notes in one compact editorial flow', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'className: "mt-2 space-y-5"',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'className: "mt-1 text-[11px] text-text-tertiary"',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'absolute right-2 top-0.5',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      '? "mt-6"',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      ': "mt-2"',
    )
  })

  it('uses compact hover note actions (no note menu, no edit action)', () => {
    // The note-level three-dot menu is gone…
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'Note actions for',
    )
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'label: "Edit note"',
    )
    // …the row reveals a quiet delete icon wired to the
    // existing confirmation flow…
    expect(MEETING_DETAIL_SOURCE).toContain(
      'Delete note: ${note.content}',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'setPendingDeleteNote(',
    )
    // …and the hover icons stay small: 16px outline artwork in a
    // 28px quiet button, revealed on row hover / focus. The
    // artwork size is pinned by the local .fg-live-note-action-icon
    // rule against the external 24px Material Symbols default
    // (unlayered vs. utilities layer).
    expect(MEETING_DETAIL_SOURCE).toContain(
      'group-hover/note:opacity-100',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'focus-within:opacity-100',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'fg-live-note-action-icon',
    )
  })

  it('keeps the quiet Work Item affordance wired to the composer', () => {
    // The in-editor "Create work item" affordance records its
    // intent and persists through the single composer path.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'handleComposerWorkItem(',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'void submitNoteComposer(',
    )
    // The affordance only appears on the NEW-Note composer
    // (the editing surface has no Work Item action).
    const editEditor =
      MEETING_DETAIL_SOURCE.indexOf(
        'onCommitDraft: () => handleNoteEditBlur(',
      )
    expect(editEditor).toBeGreaterThan(-1)
    expect(
      MEETING_DETAIL_SOURCE
        .slice(editEditor, editEditor + 200)
        .includes('workItemAction'),
    ).toBe(false)
  })

  it('autosaves the composer and Note edits on focus-leave', () => {
    // Both editors commit the draft on focus-leave (the
    // autosave model) and discard it on Escape.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'onCommitDraft: () => handleComposerBlur(',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'onCommitDraft: () => handleNoteEditBlur(',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'onEscape: handleComposerEscape',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'onEscape: handleNoteEditEscape',
    )
    // The old boxed composer row (input padding + focus ring)
    // is gone.
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'px-3 py-2 text-sm text-text outline-none focus:border-accent focus:ring-2',
    )
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'mt-2 flex items-center gap-2',
    )
  })

  it('collapses the Agenda quick-add composer after a successful create', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'setCreatingSectionId(null)',
    )
    // The collapse call must live inside handleCreateItemInSection.
    const handler = MEETING_DETAIL_SOURCE.indexOf(
      'handleCreateItemInSection',
    )
    const collapse = MEETING_DETAIL_SOURCE.indexOf(
      'setCreatingSectionId(null)',
      handler,
    )
    expect(collapse).toBeGreaterThan(handler)
    // And it must come after the create call, not before it.
    const create = MEETING_DETAIL_SOURCE.indexOf(
      'createMeetingItem(',
      handler,
    )
    expect(collapse).toBeGreaterThan(create)
  })

  it('keeps the Live quick-add composer a quiet inline agenda row', () => {
    // The opened composer reads as a temporarily editable agenda
    // row: a 28px field on the Stitch quiet canvas surface with a
    // low-contrast frame (never a control-strength outline),
    // agenda-row typography, and a compact horizontal layout.
    // The compact (h-7) control keeps the Stitch quiet palette.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'mt-1.5 flex items-center gap-1.5 pl-2 pr-2',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'h-7 min-w-0 flex-1 rounded border border-default bg-surface px-2 text-[13px] leading-[18px] text-text outline-none placeholder:text-text-tertiary focus:border-accent focus:ring-1 focus:ring-focus',
    )
    // Keyboard focus stays on the approved Stitch accent ring.
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'focus:ring-white',
    )
    // The Add action is a small quiet text action with the
    // approved focus ring, not a filled dominant button.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'LIVE_AGENDA_ADD_ACTION',
    )
  })

  it('shares the approved Sidebar typography with the Agenda navigation', () => {
    // Topics and empty navigation copy use the Sidebar child-navigation
    // role (12/16, normal); selected topics add medium weight without
    // changing size. Add-item actions deliberately sit one step below.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'px-2 fg-type-nav-secondary text-text-muted',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'min-w-0 flex-1 truncate fg-type-nav-secondary',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'isSelected ? "font-medium" : ""',
    )
    expect(MEETING_DETAIL_SOURCE).toContain('LIVE_AGENDA_ADD_ACTION')

    // Both populated and empty section headings use the shared
    // 10px semibold uppercase navigation-section role.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'mb-1 px-2 fg-type-nav-section-label text-text-muted',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'px-2 fg-type-nav-section-label text-text-tertiary',
    )

    // Add-item icons use their own smaller, leading-none role; the
    // wider Live control icon family remains unchanged.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'className: LIVE_AGENDA_ADD_ICON',
    )
  })

  it('keeps an Accent treatment for the current Agenda row only', () => {
    // Current (persisted) is the primary chromatic state: the 2px
    // accent left indicator over the quiet row surface (the
    // approved Stitch treatment) plus the accent Current label.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'absolute inset-y-0 left-0 w-[2px] bg-accent',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'item.id === meeting.currentMeetingItemId',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'shrink-0 text-[11px] font-medium leading-none text-accent-text',
    )
  })

  it('keeps Selected (viewing) rows neutral, never Accent', () => {
    // Selected != Current is local navigation: a quiet neutral
    // surface (the quiet Stitch row fill, the same as hover)
    // with no accent treatment of any kind. The accent bar and
    // Current label exist only on the current row.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'isCurrent || isSelected ? "bg-surface-hover" : "hover:bg-surface-hover"',
    )
    // The selected row is a quiet surface, not a strong/disabled
    // navigation block: no accent surface and no visible
    // "Selected" label.
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'bg-accent-selected',
    )
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'children: "Selected"',
    )
  })

  it('never renders raw internal status tokens as visible text', () => {
    // Guard against leaking enum/internal identifiers like
    // FOLLOW_UP into the UI.
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      '{liveCurrentItem.outcome}',
    )
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      "{item.outcome}",
    )
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'FOLLOW_UP',
    )
  })

  it('keeps outcome-aware resolution controls on the current item', () => {
    // Open and resolved unscheduled items offer concrete
    // scheduling, while scheduled items render their destination.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'Mark ${liveCurrentItem.title} as done',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'Schedule follow-up for ${liveCurrentItem.title}',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'Scheduled for',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'Change ${liveCurrentItem.title} to done',
    )
    // Compact (h-7) controls: Done carries the Success
    // semantic with a slight clarity lift on hover; scheduling is
    // the quietest control in the row (muted text on the pane's
    // quiet border), clearly secondary to Done.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'className: LIVE_CONTROL_SUCCESS',
    )
    // The Schedule-follow-up control (h-7 resolve row and h-7
    // reopen row) stays a neutral secondary: quiet pane border,
    // muted text, quiet surface hover.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'className: LIVE_CONTROL_SECONDARY',
    )
    // The Outcome-zone dividers sit on the semantic border-subtle
    // token (Dark #363A3F), with the calibrated mt-7 / pt-4 rhythm.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'mt-7 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-4',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'mt-7 border-t border-border-subtle pt-4',
    )
  })
})

describe('MeetingDetailPage shared header color semantics', () => {
  // The shared header (back nav, title/meta, Live indicator,
  // Start/End/Reopen, Meeting actions menu trigger/menu) uses the
  // neutral-first token system. Legacy Material color classes must
  // not remain in the shared chrome.
  //
  // Two views are asserted: the transpiled MeetingDetailPage source
  // (behavior wiring + in-page header markup) and the raw TSX source
  // file (shared MenuTrigger/MenuItem helpers live outside the
  // export, so their class strings only appear in the file).
  let fileSource = ''

  beforeAll(async () => {
    // The vitest environment is node-only; the raw TSX source is
    // read from the bundled module graph, not from the file
    // system.
    const mod = await import('./MeetingDetailPage.tsx?raw')
    fileSource = (mod as { default: string }).default
  })

  function classNameOf(
    haystack: string,
    label: string,
    anchor: string,
  ): string {
    // Anchor on the element's own opening props. In the raw TSX
    // file the button-level `className="..."` sits right after
    // `onClick={...}`, and in the transpiled page source the
    // `className: "..."` property likewise follows `onClick:` —
    // both BEFORE any child elements. Text labels and icon names
    // come after the className, so they never interfere.
    const idx = haystack.lastIndexOf(label)
    expect(idx).toBeGreaterThan(-1)
    const anchorIdx = haystack.lastIndexOf(anchor, idx)
    expect(anchorIdx).toBeGreaterThan(-1)
    const segment = haystack.slice(anchorIdx, idx)
    const value =
      segment.match(/className="([^"]*)"/)?.[1] ??
      segment.match(/className: "([^"]*)"/)?.[1]
    expect(value).not.toBeNull()
    return value as string
  }

  it('keeps back navigation neutral with canonical focus', () => {
    // Both back-navigation buttons (the loaded-page <nav> and the
    // unavailable-meeting state) must be neutral with canonical
    // focus — no persistent Accent in the idle state.
    // The completed header's back action (the last such call in
    // the file) computes its unified return destination — the
    // validated origin tab — through the shared navigation
    // helper; the button and its class string are unchanged.
    const anchors = [
      'navigate(meetingsReturnDestination)',
    ]
    for (const anchor of anchors) {
      const idx = fileSource.lastIndexOf(anchor)
      expect(idx).toBeGreaterThan(-1)
      // The className attribute follows the onClick prop on the
      // same <button>.
      const after = fileSource.slice(idx, idx + 400)
      // (the nav className is a template literal in the
      // Completed state, so the window covers the full value)
      const afterWide = fileSource.slice(idx, idx + 700)
      const value =
        after.match(/className="([^"]*)"/)?.[1] ??
        afterWide.match(/className={`([^`]*)`}/)?.[1]
      expect(value).toMatch(/text-text-muted/)
      expect(value).toContain('hover:bg-surface-hover')
      expect(value).toContain('hover:text-text')
      expect(value).toContain('focus-visible:ring-2')
      expect(value).toContain('focus-visible:ring-focus')
      expect(value).not.toContain('text-primary')
      expect(value).not.toContain('hover:text-primary')
    }
  })

  it('keeps the Meeting actions trigger neutral with canonical focus', () => {
    // MenuTrigger is a shared helper above the page export, so the
    // class string lives in the file source.
    const trigger =
      'flex h-8 w-8 items-center justify-center rounded-lg text-text-muted outline-none transition hover:bg-surface-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface'
    expect(fileSource).toContain(trigger)
    // The migrated trigger class must not carry any legacy
    // ring-primary variant.
    expect(fileSource).not.toContain(
      'focus-visible:ring-primary/30',
    )
  })

  it('classifies Start meeting with the approved Stitch primary treatment', () => {
    // The approved design uses its own accent button treatment
    // (#6E9BF5 / #101114) for the Upcoming header; the Start
    // action keeps the canonical focus ring with that palette.
    const start = classNameOf(MEETING_DETAIL_SOURCE, 'Start meeting', 'handleStartMeeting')
    expect(start).toContain('bg-[#6E9BF5]')
    expect(start).toContain('text-[#101114]')
    expect(start).toContain('hover:bg-[#5a87e0]')
    expect(start).toContain('focus-visible:ring-2')
    expect(start).toContain('focus-visible:ring-[#6898F0]')
  })

  it('classifies End meeting as a restrained destructive action', () => {
    expect(fileSource).toContain('className={LIVE_CONTROL_DANGER}')
    expect(fileSource).toContain(
      'border border-default bg-transparent text-danger hover:bg-danger-bg hover:border-danger hover:text-danger',
    )
    expect(fileSource).not.toContain(
      'LIVE_CONTROL_DANGER} bg-danger',
    )
  })

  it('classifies Reopen meeting as a neutral secondary action', () => {
    const reopen = classNameOf(MEETING_DETAIL_SOURCE, 'Reopen meeting', 'handleReopenMeeting')
    expect(reopen).toContain('text-text-muted')
    expect(reopen).toContain('hover:bg-surface-hover')
    expect(reopen).toContain('focus-visible:ring-2')
    expect(reopen).toContain('focus-visible:ring-focus')
    expect(reopen).not.toContain('bg-primary')
    expect(reopen).not.toContain('bg-accent')
    expect(reopen).not.toContain('bg-success')
  })

  it('keeps the header meta and title neutral, and the Live indicator a compact pill', () => {
    // The Completed / cancelled fallback header keeps the
    // neutral title + meta treatment.
    expect(fileSource).toContain(
      'text-3xl font-semibold tracking-tight text-text',
    )
    expect(fileSource).toContain(
      'mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-text-muted',
    )
    // The Live indicator is a compact Stitch pill: quiet surface,
    // low-contrast border, pulsing accent dot, muted "Live"
    // label — never a broad accent header treatment.
    expect(fileSource).toContain(
      'rounded border border-border-subtle bg-surface-subtle px-2 py-0.5',
    )
    expect(fileSource).toContain(
      'animate-pulse text-[14px] text-accent-text',
    )
    expect(fileSource).toContain(
      'text-[13px] leading-[18px] text-text-muted',
    )
  })

  it('keeps the shared Meeting actions menu neutral with Danger delete', () => {
    expect(fileSource).toContain(
      'z-50 w-52 rounded-xl border border-border-subtle bg-surface p-1',
    )
    expect(fileSource).toContain('Delete meeting')
    // Menu items (shared MenuItem helper): ordinary = neutral,
    // destructive = Danger. No Accent for clickable items.
    expect(fileSource).toContain(
      'text-danger hover:bg-danger-bg focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset',
    )
    expect(fileSource).toContain(
      'text-text hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset',
    )
  })

  it('keeps the header error alert on semantic Danger tokens', () => {
    expect(fileSource).toContain(
      'rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger',
    )
  })

  it('never uses the dead border-subtle utility (borders stay semantic)', () => {
    // The token is --color-border-subtle, so the color utility is
    // `border-border-subtle`. A bare `border-subtle` compiles to
    // nothing and leaves the 1px border on currentColor — the
    // Live-detail dividers then rendered near-white in Dark.
    expect(fileSource).not.toMatch(/(^|\s)border-subtle(\s|"|')/)
    expect(fileSource).not.toContain('hover:border-subtle')
  })
})

describe('MeetingDetailPage Live header (approved Stitch composition)', () => {
  let fileSource = ''

  beforeAll(async () => {
    const mod = await import('./MeetingDetailPage.tsx?raw')
    fileSource = (mod as { default: string }).default
  })

  it('renders the breadcrumb: Meetings / Group or Project / Title', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      '"aria-label": "Breadcrumb"',
    )
    // The scope segment is derived (group name or project name).
    expect(MEETING_DETAIL_SOURCE).toContain('liveScopeName')
    expect(fileSource).toContain('Project Meeting')
    expect(fileSource).toContain('Research Group Meeting')
    // The Meeting title keeps the compact breadcrumb-title
    // treatment as the page's single level-1 heading.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'min-w-0 truncate text-[15px] font-semibold leading-[18px] text-text',
    )
  })

  it('shows the compact Live pill with the elapsed timer from startedAt', () => {
    // The pill labels the state and derives the elapsed time from
    // the Meeting's persisted startedAt (gracefully absent when
    // null).
    expect(MEETING_DETAIL_SOURCE).toContain('LiveElapsedTimer')
    expect(MEETING_DETAIL_SOURCE).toContain(
      'startedAt: meeting.startedAt',
    )
  })

  it('shows the participant avatar stack with an overflow indicator', () => {
    // Four avatars maximum; the remainder collapse into a
    // +N overflow chip (actual participants only).
    expect(MEETING_DETAIL_SOURCE).toContain(
      'sortedParticipants.slice(0, 4)',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'participants.length > 4',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'rounded-full bg-surface-muted text-[11px] font-medium text-text',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'rounded-full bg-surface-subtle text-[10px] font-medium text-text-tertiary',
    )
  })

  it('retains the administrator Meeting actions menu in the Live header', () => {
    // The Meeting actions menu trigger stays offered (unchanged)
    // inside the Live header branch.
    const liveHeader =
      MEETING_DETAIL_SOURCE.indexOf('liveScopeName')
    const adminMenu = MEETING_DETAIL_SOURCE.indexOf(
      'Meeting actions',
      liveHeader,
    )
    expect(liveHeader).toBeGreaterThan(-1)
    expect(adminMenu).toBeGreaterThan(liveHeader)
  })

  it('keeps the elapsed timer in a leaf component (isolated re-render)', () => {
    // The 1-second interval lives inside the leaf timer
    // component (module scope, before the page), so the tick
    // re-renders the label only — never the Meeting page.
    expect(fileSource).toContain('function LiveElapsedTimer')
    expect(fileSource).toContain('function formatLiveElapsed')
    const timerDef = fileSource.indexOf(
      'function LiveElapsedTimer',
    )
    const pageDef = fileSource.indexOf(
      'export function MeetingDetailPage',
    )
    const interval = fileSource.indexOf(
      'window.setInterval',
      timerDef,
    )
    expect(timerDef).toBeGreaterThan(-1)
    expect(interval).toBeGreaterThan(timerDef)
    expect(interval).toBeLessThan(pageDef)
  })

  it('hides the timer gracefully when startedAt is missing', () => {
    expect(fileSource).toContain(
      'if (startedAt == null)',
    )
  })
})
