import {
  formatNoteTime,
  getPersonName,
  itemResultingWork,
} from './shared'

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
}: {
  linked: ApiLinkedWorkItem
  onOpen: (linked: ApiLinkedWorkItem) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(linked)}
      aria-label={`Open linked work item: ${linked.title}`}
      className="flex w-full items-start gap-2 rounded-md px-1 py-0.5 text-left outline-none transition hover:bg-surface-container-low/70 focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <span
        aria-hidden="true"
        className="material-symbols-outlined mt-px text-[15px] text-on-surface-variant"
      >
        task_alt
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-on-surface">
          {linked.title}
        </span>

        <span className="block truncate text-[11px] text-on-surface-variant">
          {[
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
      <p className="whitespace-pre-wrap text-sm leading-6 text-on-surface">
        {note.content}
      </p>

      <p className="mt-1.5 text-[11px] text-on-surface-variant/70">
        {getPersonName(note.author)} ·{' '}
        {formatNoteTime(note.createdAt)}
      </p>

      {/* Traceability: the canonical Work Item this exact Note
          produced, rendered at its origin. */}
      {note.linkedWorkItem != null && (
        <div className="mt-1.5">
          <p className="text-[11px] font-medium text-on-surface-variant">
            Resulting work
          </p>

          <div className="mt-0.5">
            <LinkedWorkButton
              linked={note.linkedWorkItem}
              onOpen={onOpenLinkedWork}
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
      <h2 className="text-base font-semibold text-on-surface">
        Outcomes
      </h2>

      <div className="mt-3 space-y-5">
        {workItems.length > 0 && (
          <div>
            <p className="text-[13px] font-semibold text-on-surface-variant">
              Resulting work
            </p>

            <ul className="mt-1.5 space-y-0.5">
              {workItems.map((linked) => (
                <li key={linked.id}>
                  <LinkedWorkButton
                    linked={linked}
                    onOpen={onOpenLinkedWork}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}

        {followUps.length > 0 && (
          <div>
            <p className="text-[13px] font-semibold text-on-surface-variant">
              Follow-ups
            </p>

            <ul className="mt-1.5 space-y-1">
              {followUps.map((item) => (
                <li key={item.id} className="min-w-0">
                  <span className="flex items-baseline gap-2 text-sm text-on-surface">
                    <span
                      aria-hidden="true"
                      className="shrink-0 text-on-surface-variant"
                    >
                      ↻
                    </span>
                    <span className="min-w-0 break-words">
                      {item.title}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}

/* ── Protocol: the complete historical record ────────────────── */

interface ProtocolProps {
  sections: ApiMeetingSection[]
  itemsBySection: Map<number, ApiMeetingItem[]>
  workById: Map<number, ApiLinkedWorkItem>
  onOpenLinkedWork: (linked: ApiLinkedWorkItem) => void
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
      className="min-w-0 border-t border-outline-variant pt-8"
    >
      <h2 className="text-base font-semibold text-on-surface">
        Protocol
      </h2>

      <div className="mt-5 max-w-[800px] space-y-10">
        {sections.length === 0 ? (
          <p className="text-sm text-on-surface-variant">
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
                <h3 className="border-b border-outline-variant pb-2 text-lg font-semibold tracking-tight text-on-surface">
                  {section.name}
                </h3>

                {sectionItems.length === 0 ? (
                  <p className="mt-2 text-sm text-on-surface-variant">
                    No items
                  </p>
                ) : (
                  <ul className="mt-4 space-y-6">
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

                      return (
                        <li key={item.id} className="min-w-0">
                          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                            <span
                              aria-hidden="true"
                              className="shrink-0 select-none text-xs tabular-nums text-on-surface-variant/50"
                            >
                              {itemIndex + 1}
                            </span>

                            <h4 className="min-w-0 flex-1 break-words text-[15px] font-medium text-on-surface">
                              {item.title}
                            </h4>

                            {item.outcome ===
                              'not_discussed' && (
                              <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium text-on-surface-variant">
                                <span
                                  aria-hidden="true"
                                  className="material-symbols-outlined text-[13px]"
                                >
                                  circle
                                </span>
                                Not discussed
                              </span>
                            )}

                            {item.outcome ===
                              'follow_up' && (
                              <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium text-on-surface-variant">
                                <span aria-hidden="true">↻</span>
                                Follow-up
                              </span>
                            )}
                          </div>

                          {/* Direct MeetingItem -> Work Item links,
                              rendered at the owning item (Work
                              already shown at its Note is not
                              repeated here). */}
                          {itemLevelWork.length > 0 && (
                            <div className="mt-2 pl-5">
                              <p className="text-[11px] font-medium text-on-surface-variant">
                                Resulting work
                              </p>

                              <div className="mt-0.5">
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

                          {/* Notes: protocol text, fully
                              visible, attribution secondary. */}
                          {notes.length > 0 && (
                            <div className="mt-3 pl-5">
                              <p className="text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant/80">
                                Notes
                              </p>

                              <ul className="mt-2.5 space-y-5">
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
  return (
    <div data-completed-recap>
      {/* 1. Outcomes (only when there is actual content) */}
      <div className="mt-8">
        <CompletedMeetingOutcomes
          items={sortedItems}
          workById={workById}
          onOpenLinkedWork={onOpenLinkedWork}
        />
      </div>

      {/* 2. Full protocol */}
      <div className="mt-8">
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
