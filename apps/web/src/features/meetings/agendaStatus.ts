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
