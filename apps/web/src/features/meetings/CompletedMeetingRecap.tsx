import {
  formatNoteTime,
  getPersonName,
  itemResultingWork,
  formatMeetingDateShort,
} from './shared'

import {
  AGENDA_STATUS_META,
} from './agendaStatus'

import type {
  ApiLinkedWorkItem,
  ApiMeetingItem,
  ApiMeetingNote,
  ApiMeetingSection,
} from '../../api/types'

/* ── Compact Work Item row (Outcomes + Protocol) ─────────────── */

export function LinkedWorkButton({
  linked,
  onOpen,
  meta,
}: {
  linked: ApiLinkedWorkItem
  onOpen: (linked: ApiLinkedWorkItem) => void
  // Optional explicit meta line (Project · Assignee · Status,
  // the canonical relation contract). Callers without an
  // explicit meta keep the compact fallback order.
  meta?: string
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(linked)}
      aria-label={`Open linked work item: ${linked.title}`}
      className="flex min-h-[38px] w-full items-start gap-2 rounded-md py-0.5 text-left outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus"
    >
      <span
        aria-hidden="true"
        className="material-symbols-outlined mt-px text-[18px] text-text-muted"
      >
        task_alt
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-[18px] font-semibold text-text">
          {linked.title}
        </span>

        <span className="mt-0.5 block truncate text-[11px] leading-4 text-text-muted">
          {meta ??
            [
              linked.assigneeNames.length > 0
                ? linked.assigneeNames.join(', ')
                : 'Unassigned',
              linked.projectName,
              linked.statusName,
            ].join(' · ')}
        </span>
      </span>
    </button>
  )
}

/* ── Follow-up scheduled-destination line (Outcomes) ────────── */

// Mirrors the authoritative Live-view wording and uses only
// fields that are part of the canonical followUpSchedule
// payload as compact destination metadata:
// "<Meeting> · <Date> · <Section>". The Follow-ups anchor
// already carries the semantics, so the row lists only
// trustworthy target fields; missing optional parts are
// omitted rather than invented.
//
// Lifecycle semantics (docs/domain/meetings.md, section 18):
// - "scheduled": the concrete target is active -> line.
// - "needs_reschedule": the original references are retained
//   for history only; the target is no longer valid -> no
//   line (it would falsely imply an active schedule).
// - "cancelled": the server excludes cancelled records from
//   followUpSchedule, and cancelling reverts the source
//   outcome to not_discussed, so this cannot be observed
//   here.
function followUpScheduleLine(
  schedule: NonNullable<ApiMeetingItem['followUpSchedule']>,
): string | null {
  if (schedule.status !== 'scheduled') {
    return null
  }

  return [
    schedule.targetMeetingTitle,
    formatMeetingDateShort(schedule.targetMeetingScheduledAt),
    schedule.targetMeetingSectionName,
  ]
    .filter(Boolean)
    .join(' · ')
}

/* ── One Note entry: protocol text + quiet attribution ──────── */

function NoteEntry({
  note,
  onOpenLinkedWork,
}: {
  note: ApiMeetingNote
  onOpenLinkedWork: (linked: ApiLinkedWorkItem) => void
}) {
  return (
    <li className="min-w-0">
      <p className="whitespace-pre-wrap text-[14px] leading-[22px] text-text">
        {note.content}
      </p>

      <p className="mt-1 text-[11px] leading-4 text-text-muted">
        {getPersonName(note.author)} ·{' '}
        {formatNoteTime(note.createdAt)}
      </p>

      {/* Traceability: the canonical Work Item this exact Note
          produced, rendered at its origin. */}
      {note.linkedWorkItem != null && (
        <div className="mt-1.5">
          <p className="text-[11px] leading-4 font-semibold text-text-tertiary">
            Resulting work
          </p>

          <div className="mt-0.5">
            <LinkedWorkButton
              linked={note.linkedWorkItem}
              onOpen={onOpenLinkedWork}
              meta={[
                note.linkedWorkItem.projectName,
                note.linkedWorkItem.assigneeNames.length > 0
                  ? note.linkedWorkItem.assigneeNames.join(', ')
                  : 'Unassigned',
                note.linkedWorkItem.statusName,
              ].join(' · ')}
            />
          </div>
        </div>
      )}
    </li>
  )
}

/* ── Outcomes: derived from canonical Meeting data ──────────── */

interface OutcomesProps {
  items: ApiMeetingItem[]
  workById: Map<number, ApiLinkedWorkItem>
  onOpenLinkedWork: (linked: ApiLinkedWorkItem) => void
}

export function CompletedMeetingOutcomes({
  items,
  workById,
  onOpenLinkedWork,
}: OutcomesProps) {
  // All canonical Work Items originating from this Meeting, in
  // canonical item order, deduplicated by Work Item id.
  const resultingWork = new Map<number, ApiLinkedWorkItem>()

  for (const item of items) {
    for (const linked of itemResultingWork(item, workById)) {
      if (!resultingWork.has(linked.id)) {
        resultingWork.set(linked.id, linked)
      }
    }
  }

  const workItems = [...resultingWork.values()]
  const followUps = items.filter(
    (item) => item.outcome === 'follow_up',
  )

  const hasContent =
    workItems.length > 0 || followUps.length > 0

  if (!hasContent) {
    return null
  }

  return (
    <section aria-label="Outcomes">
      <h2 className="text-[20px] leading-7 font-semibold text-text">
        Outcomes
      </h2>

      <div className="mt-4 space-y-5">
        {workItems.length > 0 && (
          <div>
            <p className="text-[11px] leading-4 font-semibold text-text-muted">
              Resulting work
            </p>

            <ul className="mt-2 space-y-1.5">
              {workItems.map((linked) => (
                <li key={linked.id}>
                  <LinkedWorkButton
                    linked={linked}
                    onOpen={onOpenLinkedWork}
                    meta={[
                      linked.projectName,
                      linked.assigneeNames.length > 0
                        ? linked.assigneeNames.join(', ')
                        : 'Unassigned',
                      linked.statusName,
                    ].join(' · ')}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}

        {followUps.length > 0 && (
          <div>
            <p className="text-[11px] leading-4 font-semibold text-text-muted">
              Follow-ups
            </p>

            <ul className="mt-2 space-y-1.5">
              {followUps.map((item) => (
                <FollowUpRow key={item.id} item={item} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}

/* ── Protocol: the complete historical record ────────────────── */

/* One Follow-up row: title plus its truthful secondary line.
   outcome=follow_up without an active schedule is a valid
   user-visible state (legacy outcome-only action and
   pre-scheduling history) and its secondary line says exactly
   that; a needs_reschedule schedule keeps no destination line. */
function FollowUpRow({ item }: { item: ApiMeetingItem }) {
  const secondary = item.followUpSchedule == null
    ? 'Follow-up not scheduled'
    : followUpScheduleLine(item.followUpSchedule)

  return (
    <li className="min-w-0">
      <div className="flex items-start gap-2">
        {/* Stable plain-unicode marker from the
            shared Agenda mapping — never an icon-font
            ligature, so no raw icon/enum name can leak
            into the summary. */}
        <span
          aria-hidden="true"
          className="shrink-0 select-none text-[14px] leading-5 text-text-muted"
        >
          {AGENDA_STATUS_META.follow_up.symbol}
        </span>

        <div className="min-w-0">
          <p className="break-words text-[13px] leading-[18px] font-semibold text-text">
            {item.title}
          </p>

          {secondary != null && (
            <p className="mt-0.5 break-words text-[11px] leading-4 text-text-muted">
              {secondary}
            </p>
          )}
        </div>
      </div>
    </li>
  )
}

interface ProtocolProps {
  sections: ApiMeetingSection[]
  itemsBySection: Map<number, ApiMeetingItem[]>
  workById: Map<number, ApiLinkedWorkItem>
  onOpenLinkedWork: (linked: ApiLinkedWorkItem) => void
}

/* ── Exception marker: only non-done outcomes ─────────
   Plain-unicode symbols from the shared Live Agenda mapping
   (AGENDA_STATUS_META) — never an icon-font ligature, so no
   raw icon/enum name can leak into the record. Ordinary Done
   items render NO marker: the Protocol is a document, and the
   signal is reserved for exceptions. */

function ProtocolOutcomeMarker({
  outcome,
}: {
  outcome: 'follow_up' | 'not_discussed'
}) {
  const meta = AGENDA_STATUS_META[outcome]

  return (
    <span className="inline-flex shrink-0 items-baseline gap-1 text-[11px] leading-4 font-medium text-text-muted">
      <span aria-hidden="true" className="text-[12px]">{meta.symbol}</span>
      {meta.label}
    </span>
  )
}

export function CompletedMeetingProtocol({
  sections,
  itemsBySection,
  workById,
  onOpenLinkedWork,
}: ProtocolProps) {
  return (
    <section
      aria-label="Protocol"
      className="min-w-0 border-t border-border-subtle pt-7"
    >
      <h2 className="text-[20px] leading-7 font-semibold text-text">
        Protocol
      </h2>

      <div className="mt-5 space-y-10">
        {sections.length === 0 ? (
          <p className="text-sm text-text-muted">
            No agenda sections.
          </p>
        ) : (
          sections.map((section) => {
            const sectionItems =
              itemsBySection.get(section.id) ?? []

            return (
              <section
                key={section.id}
                aria-label={section.name}
              >
                <h3 className="border-b border-border-subtle pb-2 text-base leading-6 font-semibold text-text">
                  {section.name}
                </h3>

                {sectionItems.length === 0 ? (
                  <p className="mt-2 text-sm text-text-muted">
                    No items
                  </p>
                ) : (
                  <ul className="mt-[18px] space-y-7">
                    {sectionItems.map((item, itemIndex) => {
                      const notes = item.notes ?? []
                      const directWork = itemResultingWork(
                        item,
                        workById,
                      )
                      // Direct item links already include the Note's
                      // primary Work Item (deduped); render the
                      // item-level subsection only for Work that is
                      // NOT already shown at its exact Note.
                      const noteWorkIds = new Set(
                        notes
                          .map((note) => note.linkedWorkItem?.id)
                          .filter((id): id is number => id != null),
                      )
                      const itemLevelWork = directWork.filter(
                        (linked) => !noteWorkIds.has(linked.id),
                      )

                      // Two-column mini-layout: a narrow number
                      // column, then one content column so title,
                      // exception state, Notes, note bodies,
                      // attribution, and Resulting work all start
                      // on the same axis.
                      return (
                        <li
                          key={item.id}
                          className="grid min-w-0 grid-cols-[20px_minmax(0,1fr)] items-baseline gap-x-3"
                        >
                          <span
                            aria-hidden="true"
                            className="select-none text-[11px] leading-5 tabular-nums text-text-tertiary"
                          >
                            {itemIndex + 1}
                          </span>

                          <div className="min-w-0">
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                              <h4 className="min-w-0 break-words text-[14px] leading-5 font-semibold text-text">
                                {item.title}
                              </h4>

                              {/* Exception state beside the
                                  title — ordinary Done items
                                  carry none. */}
                              {item.outcome === 'follow_up' ? (
                                <ProtocolOutcomeMarker
                                  outcome="follow_up"
                                />
                              ) : item.outcome === 'not_discussed' ? (
                                <ProtocolOutcomeMarker
                                  outcome="not_discussed"
                                />
                              ) : null}
                            </div>

                            {/* Notes: protocol text, fully
                                visible, attribution secondary. */}
                            {notes.length > 0 && (
                              <div className="mt-3">
                                <p className="text-[11px] leading-4 font-semibold text-text-tertiary">
                                  Notes
                                </p>

                                <ul className="mt-2 space-y-4">
                                  {notes.map((note) => (
                                    <NoteEntry
                                      key={note.id}
                                      note={note}
                                      onOpenLinkedWork={
                                        onOpenLinkedWork
                                      }
                                    />
                                  ))}
                                </ul>
                              </div>
                            )}

                            {/* Direct MeetingItem -> Work Item
                                links, rendered at the owning item
                                (Work already shown at its Note is
                                not repeated here). */}
                            {itemLevelWork.length > 0 && (
                              <div className="mt-3">
                                <p className="text-[11px] leading-4 font-semibold text-text-tertiary">
                                  Resulting work
                                </p>

                                <div className="mt-1.5">
                                  {itemLevelWork.map((linked) => (
                                    <LinkedWorkButton
                                      key={linked.id}
                                      linked={linked}
                                      onOpen={onOpenLinkedWork}
                                    />
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            )
          })
        )}
      </div>
    </section>
  )
}


/* ── The full Completed recap ────────────────────────────────── */

interface CompletedMeetingRecapProps {
  sortedSections: ApiMeetingSection[]
  sortedItems: ApiMeetingItem[]
  itemsBySection: Map<number, ApiMeetingItem[]>
  // Canonical display data for every Work Item originating from
  // this Meeting (Note-linked + direct item-linked), hydrated by
  // the parent via the existing Work Item API.
  workById: Map<number, ApiLinkedWorkItem>
  onOpenLinkedWork: (linked: ApiLinkedWorkItem) => void
}

export function CompletedMeetingRecap({
  sortedSections,
  sortedItems,
  itemsBySection,
  workById,
  onOpenLinkedWork,
}: CompletedMeetingRecapProps) {
  // Content only: the page header owns the Meeting identity,
  // Completed state, metadata, and the outcome-count line.
  // One identical document width (840px) for Outcomes, the
  // Outcomes to Protocol divider, and the Protocol record;
  // left-aligned, right side stays open.
  return (
    <div
      data-completed-recap
      className="w-full max-w-[840px]"
    >
      {/* 1. Outcomes (only when there is actual content) */}
      <div className="mt-7">
        <CompletedMeetingOutcomes
          items={sortedItems}
          workById={workById}
          onOpenLinkedWork={onOpenLinkedWork}
        />
      </div>

      {/* 2. Full protocol */}
      <div className="mt-4">
        <CompletedMeetingProtocol
          sections={sortedSections}
          itemsBySection={itemsBySection}
          workById={workById}
          onOpenLinkedWork={onOpenLinkedWork}
        />
      </div>
    </div>
  )
}
