// Shared, presentation-only mapping of the canonical Live
// MeetingItem outcomes to their Agenda-rail representation: a
// stable symbol plus accessible text (the symbol alone is never
// the only signal).
//
// "current" is NOT an outcome: the current item is the one whose id
// matches Meeting.currentMeetingItemId.
export type AgendaItemOutcome =
  | 'not_discussed'
  | 'done'
  | 'follow_up'

export const AGENDA_STATUS_META: Record<
  AgendaItemOutcome,
  { symbol: string; label: string; hint: string }
> = {
  done: {
    symbol: '✓',
    label: 'Done',
    hint: 'Completed',
  },
  follow_up: {
    symbol: '↻',
    label: 'Follow-up',
    hint: 'Resolved with follow-up',
  },
  not_discussed: {
    symbol: '○',
    label: 'Not discussed',
    hint: 'Open',
  },
}

export function agendaStatusMeta(
  outcome: AgendaItemOutcome,
) {
  return AGENDA_STATUS_META[outcome]
}

/* ── Completed recap outcome markers ──────────────────────────
   Small, presentation-only mapping of the canonical
   MeetingItem outcomes to a compact, document-style result
   marker (icon + visible label). The icon is presentational
   (rendered aria-hidden); the visible label carries the meaning.

   "current" is NOT an outcome. This mapping is presentation-only;
   the canonical outcome enum values are never renamed here. */

export type ItemOutcome =
  | 'not_discussed'
  | 'done'
  | 'follow_up'

export const ITEM_OUTCOME_META: Record<
  ItemOutcome,
  { icon: string; label: string }
> = {
  not_discussed: {
    icon: 'circle',
    label: 'Not discussed',
  },
  done: {
    icon: 'check_circle',
    label: 'Done',
  },
  follow_up: {
    // "followup" is the valid Material Symbols ligature. The
    // invalid "follow_up" ligature renders as raw FOLLOW_UP text.
    icon: 'followup',
    label: 'Follow-up',
  },
}
