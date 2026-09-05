import { describe, expect, it } from 'vitest'

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

  it('derives the current item from the discussing status', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'item.status === "discussing"',
    )
  })

  it('exposes canonical Focus, Done and Follow-up actions', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('handleFocusItem')
    expect(MEETING_DETAIL_SOURCE).toContain('handleDoneItem')
    expect(MEETING_DETAIL_SOURCE).toContain(
      'handleFollowUpItem',
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

  it('offers an explicit structure editing mode', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('Edit structure')
    expect(MEETING_DETAIL_SOURCE).toContain('Add section')
  })

  it('supports inline quick-add for agenda items', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('Add item')
  })
})

describe('MeetingDetailPage participant surface', () => {
  it('renders a compact participant context with explicit manage state', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('Participants')
    expect(MEETING_DETAIL_SOURCE).toContain('Manage')
    expect(MEETING_DETAIL_SOURCE).toContain(
      'manage_accounts',
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
    // Live: the Current Item workspace renders this item's Notes;
    // Completed: the classic protocol layout keeps rendering them.
    expect(MEETING_DETAIL_SOURCE).toContain(
      '(liveCurrentItem.notes ?? []).length >',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      '(item.notes ?? []).length >',
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

  it('renders an Agenda rail beside a Current Item workspace', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      '"aria-label": "Agenda"',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      '"aria-label": "Current item"',
    )
  })

  it('derives the current item from the canonical discussing status', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      "sortedItems.find((item) => item.status === \"discussing\")",
    )
    // The current item is always derived; it is never persisted.
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'currentMeetingItemId',
    )
  })

  it('shows the Section name and section-relative position', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'liveCurrentSection?.name',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'liveCurrentPosition',
    )
  })

  it('renders all four MeetingItem states with symbol and accessible text', () => {
    // Every status exposes a symbol AND an accessible text label,
    // so the symbol alone is never the only signal.
    expect(AGENDA_STATUS_META.discussing.symbol).toBe('●')
    expect(AGENDA_STATUS_META.discussing.label).toBe('Discussing')
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
    // Empty Sections stay visible with a quiet placeholder.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'No items',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'sectionItems.map((item) => {',
    )
  })

  it('wires Agenda navigation to the canonical Focus action', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      '`Focus ${item.title}`',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'void handleFocusItem(item)',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      "item.status === \"not_discussed\"",
    )
  })

  it('keeps Done and Follow up on the current item', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'void handleDoneItem(liveCurrentItem)',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'void handleFollowUpItem(',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      '`Mark ${liveCurrentItem.title} as done`',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      '`Mark ${liveCurrentItem.title} as follow-up`',
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

  it('keeps existing Note authoring and Note -> Work Item on the current item', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      '`Add note to ${liveCurrentItem.title}`',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'openNoteComposer(liveCurrentItem)',
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
      'noteComposerItemId === liveCurrentItem.id',
    )
    // Note edit mode is gated on the edit state only.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'editingNoteId === note.id',
    )
    // Add-note trigger is Live-only (no lifecycle coupling).
    expect(MEETING_DETAIL_SOURCE).toContain(
      'isLive && noteComposerItemId !== liveCurrentItem.id',
    )
    // Per-note Edit/Delete menu is Live-only, as before the
    // refactor.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'isLive && /* @__PURE__ */ (0,__vite_ssr_import_10__.jsxDEV)(MenuTrigger',
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
    // The only current-item title is the workspace heading.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'data-current-item-title',
    )
  })
})

describe('MeetingDetailPage Live visual polish', () => {
  it('hides the duplicate Participants row while Live', () => {
    // The participant context surface is hidden in the Live shell
    // because the header metadata line already shows the count.
    expect(MEETING_DETAIL_SOURCE).toContain(
      '!isLive && /* @__PURE__ */',
    )
  })

  it('keeps the participant count in the header metadata line', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'participants.length === 1',
    )
    expect(MEETING_DETAIL_SOURCE).toContain('"participant"')
    expect(MEETING_DETAIL_SOURCE).toContain('"participants"')
  })

  it('renders End meeting as a calm secondary action', () => {
    // End meeting keeps its behavior (handleEndMeeting) but uses a
    // quiet bordered treatment instead of a filled destructive one.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'void handleEndMeeting()',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'hover:bg-error-container/30',
    )
  })

  it('renders existing Notes before the Add-note composer', () => {
    // The existing-notes block must appear before the open-composer
    // conditional in the Current Item workspace source.
    const notesBlock = MEETING_DETAIL_SOURCE.indexOf(
      '(liveCurrentItem.notes ?? []).length >',
    )
    // The open composer is keyed on the composer state; the
    // closed-state trigger is keyed on the negation of that same
    // state.
    const composer = MEETING_DETAIL_SOURCE.indexOf(
      'noteComposerItemId === liveCurrentItem.id',
    )
    expect(notesBlock).toBeGreaterThan(-1)
    expect(composer).toBeGreaterThan(-1)
    expect(notesBlock).toBeLessThan(composer)
  })

  it('keeps the Add-note composer openable and quiet when closed', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'openNoteComposer(liveCurrentItem)',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'isLive && noteComposerItemId !== liveCurrentItem.id',
    )
  })

  it('keeps Create work item and Add note wired in the composer', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'submitNoteThenCreateWorkItem(',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'void submitNoteComposer(',
    )
  })

  it('reorders composer actions with Add note as primary', () => {
    // In the open composer, "Create work item" (secondary text)
    // precedes "Add note" (primary), and Cancel is the last action.
    const row = MEETING_DETAIL_SOURCE.indexOf(
      'mt-2 flex items-center gap-2',
    )
    expect(row).toBeGreaterThan(-1)
    const createWork = MEETING_DETAIL_SOURCE.indexOf(
      'Create work item',
      row,
    )
    const addNote = MEETING_DETAIL_SOURCE.indexOf(
      'Add note',
      row,
    )
    const cancel = MEETING_DETAIL_SOURCE.indexOf(
      'Cancel',
      row,
    )
    expect(createWork).toBeGreaterThan(row)
    expect(addNote).toBeGreaterThan(createWork)
    expect(cancel).toBeGreaterThan(addNote)
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

  it('keeps a subtle selected state for the current Agenda item', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'border-l-2 border-primary bg-primary/5',
    )
  })

  it('never renders raw internal status tokens as visible text', () => {
    // Guard against leaking enum/internal identifiers like
    // FOLLOW_UP into the UI.
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      '{liveCurrentItem.status}',
    )
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      "{item.status}",
    )
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'FOLLOW_UP',
    )
  })

  it('keeps Done and Follow up as one compact outcome group on the current item', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'void handleDoneItem(liveCurrentItem)',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'void handleFollowUpItem(',
    )
    // Compact (h-9) outcome actions, Done primary and Follow up
    // secondary, in the same group.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'h-9 items-center gap-1.5 rounded-lg bg-primary px-3',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'h-9 items-center gap-1.5 rounded-lg border border-outline-variant',
    )
  })
})
