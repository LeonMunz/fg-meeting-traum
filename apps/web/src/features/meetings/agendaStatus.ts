// Shared, presentation-only mapping of the canonical Live
// MeetingItem statuses to their Agenda-rail representation: a
// stable symbol plus accessible text (the symbol alone is never
// the only signal).
export type AgendaItemStatus =
  | 'not_discussed'
  | 'discussing'
  | 'done'
  | 'follow_up'

export const AGENDA_STATUS_META: Record<
  AgendaItemStatus,
  { symbol: string; label: string; hint: string }
> = {
  discussing: {
    symbol: '●',
    label: 'Discussing',
    hint: 'Discussing now',
  },
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
  status: AgendaItemStatus,
) {
  return AGENDA_STATUS_META[status]
}
