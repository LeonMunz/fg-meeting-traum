/* Compact, clickable relation card for a Work Item generated from a
   specific Meeting Note, plus its quiet caption. Pure presentation:
   no domain logic, no API access.

   The card renders directly beneath its source Note. The Note stays
   visually primary; the generated Work Item reads as a secondary
   linked follow-up entity that opens the shared Work Item inspector.
   The card surface sits one level above the surrounding canvas with a
   subtle border and a one-level-clearer hover. Every color comes from
   the semantic token vocabulary so Light and Dark resolve naturally
   (no raw hex, no dark-only overrides). */

import type { ReactNode } from 'react'

import type { ApiLinkedWorkItem } from '../../api/types'

export interface NoteLinkedWorkCardProps {
  linked: ApiLinkedWorkItem
  onOpen: (linked: ApiLinkedWorkItem) => void
}

export function NoteLinkedWorkCard({
  linked,
  onOpen,
}: NoteLinkedWorkCardProps): ReactNode {
  const assignee =
    linked.assigneeNames.length > 0
      ? linked.assigneeNames.join(', ')
      : null

  const metaParts: string[] = [linked.projectName]
  if (assignee != null) {
    metaParts.push(assignee)
  }
  metaParts.push(linked.statusName)

  return (
    <button
      type="button"
      onClick={() => onOpen(linked)}
      aria-label={`Open linked work item: ${linked.title}`}
      className="mt-1.5 flex w-full items-center gap-2.5 rounded-xl border border-subtle bg-surface px-3.5 py-3 text-left outline-none transition hover:border-default hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
    >
      {/* Neutral relation glyph. The canonical payload carries no
          Work Item type/icon, so we do not fabricate one; the shared
          inspector remains the source of type detail. */}
      <span
        aria-hidden="true"
        className="material-symbols-outlined shrink-0 text-[18px] text-text-muted"
      >
        check_box_outline_blank
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text">
          {linked.title}
        </span>

        <span className="block truncate text-xs text-text-muted">
          {metaParts.join(' · ')}
        </span>
      </span>
    </button>
  )
}

/* Quiet caption above the linked Work Item card. No container or
   border — just a small muted label so the relation reads as
   secondary to the Note above it. A Note has at most one primary
   linked Work Item (enforced by the existing unique constraint), so
   the caption is singular. */
export function NoteLinkedWorkCaption(): ReactNode {
  return (
    <p className="text-[11px] font-medium text-text-muted">
      Linked work item
    </p>
  )
}
