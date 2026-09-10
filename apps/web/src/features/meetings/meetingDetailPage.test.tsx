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
    // Live: the item-detail pane renders the SELECTED (viewed)
    // item's Notes; Completed: the classic protocol layout keeps
    // rendering them.
    expect(MEETING_DETAIL_SOURCE).toContain(
      '(liveSelectedItem.notes ?? []).length >',
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
    // Empty Sections stay visible with a quiet placeholder.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'No items',
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

  it('renders End meeting as a calm Danger secondary action', () => {
    // End meeting keeps its behavior (handleEndMeeting) but uses a
    // quiet bordered treatment that only takes on Danger in hover,
    // instead of a filled destructive control.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'void handleEndMeeting()',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'hover:bg-danger-subtle',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'hover:text-danger',
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
      'className: "mt-1 text-[11px] text-text-muted/70"',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'absolute right-2 top-1',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      '? "mt-5"',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      ': "mt-2"',
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

  it('keeps an Accent treatment for the current Agenda row only', () => {
    // Current (persisted) is the primary chromatic state: an accent
    // left indicator over a subtle accent surface.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'border-l-2 border-accent bg-accent-subtle',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'item.id === meeting.currentMeetingItemId',
    )
  })

  it('keeps Selected (viewing) rows neutral, never Accent', () => {
    // Selected != Current is local navigation: a neutral muted
    // surface with no accent classes.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'border-l-2 border-transparent bg-surface-muted',
    )
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
    // Compact (h-9) controls: Done carries the Success
    // semantic; scheduling / Change-to transitions are neutral
    // secondary controls.
    expect(MEETING_DETAIL_SOURCE).toContain(
      'h-9 items-center gap-1.5 rounded-lg bg-success px-3',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'h-9 items-center gap-1.5 rounded-lg border border-default bg-surface px-3',
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
    const anchors = [
      "navigate('/meetings')",
    ]
    for (const anchor of anchors) {
      const idx = fileSource.lastIndexOf(anchor)
      expect(idx).toBeGreaterThan(-1)
      // The className attribute follows the onClick prop on the
      // same <button>.
      const after = fileSource.slice(idx, idx + 400)
      const value = after.match(/className="([^"]*)"/)?.[1]
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

  it('classifies Start meeting as the primary Accent action', () => {
    const start = classNameOf(MEETING_DETAIL_SOURCE, 'Start meeting', 'handleStartMeeting')
    expect(start).toContain('bg-accent')
    expect(start).toContain('text-text-inverse')
    expect(start).toContain('hover:bg-accent-hover')
    expect(start).toContain('focus-visible:ring-2')
    expect(start).toContain('focus-visible:ring-focus')
    expect(start).toContain('focus-visible:ring-offset-2')
    expect(start).not.toContain('bg-primary')
    expect(start).not.toContain('ring-primary')
  })

  it('classifies End meeting as a Danger hover treatment', () => {
    const end = classNameOf(MEETING_DETAIL_SOURCE, 'End meeting', 'handleEndMeeting')
    expect(end).toContain('border-border-subtle')
    expect(end).toContain('hover:bg-danger-subtle')
    expect(end).toContain('hover:text-danger')
    expect(end).toContain('focus-visible:ring-2')
    expect(end).toContain('focus-visible:ring-focus')
    // The idle state stays neutral; no persistent Danger fill.
    expect(end).not.toContain('bg-danger ')
    expect(end).not.toContain('bg-danger"')
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

  it('keeps the header meta, title, and Live indicator neutral', () => {
    expect(fileSource).toContain(
      'text-3xl font-semibold tracking-tight text-text',
    )
    expect(fileSource).toContain(
      'mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-text-muted',
    )
    // The Live indicator stays a small Accent-text state, never a
    // broad indigo header treatment.
    expect(fileSource).toContain(
      'text-sm font-medium text-accent-text" role="status"',
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
})
