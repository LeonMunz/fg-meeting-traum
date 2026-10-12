/**
 * Shared Meetings URL/navigation contract for the Meetings list
 * tabs and the concrete Meeting detail's return behavior.
 *
 * Meetings list tabs — the URL is the single source of truth for
 * the selected tab (there is no independent active-tab state):
 *
 *   /meetings              → Upcoming
 *   /meetings?tab=upcoming → Upcoming
 *   /meetings?tab=series   → Series
 *   /meetings?tab=past     → Past
 *   /meetings?tab=unknown  → Upcoming fallback (the URL is left
 *                            untouched — no automatic redirect)
 *
 * Tab activation (pointer or arrow keys) updates the URL through
 * React Router and pushes a history entry, so Browser Back/Forward
 * restore the tab represented by each entry. Upcoming is the bare
 * /meetings — the `tab` query is only carried for the other tabs,
 * so canonical links stay minimal.
 *
 * Concrete Meeting detail return origin — the `from` query value on
 * /meetings/{id} records which Meetings tab the detail was opened
 * from. Only known tab identifiers are accepted; the value is never
 * interpreted as a URL or navigation destination:
 *
 *   /meetings/{id}                 → return to /meetings
 *   /meetings/{id}?from=upcoming   → return to /meetings
 *   /meetings/{id}?from=series     → return to /meetings?tab=series
 *   /meetings/{id}?from=past       → return to /meetings?tab=past
 *   /meetings/{id}?from=<anything> → return to /meetings (safe
 *                                     fallback — never a foreign
 *                                     URL)
 */

export const MEETINGS_TAB_IDS = [
  'upcoming',
  'series',
  'past',
] as const

export type MeetingsTabId = (typeof MEETINGS_TAB_IDS)[number]

const MEETINGS_TAB_SET: ReadonlySet<string> =
  new Set<string>(MEETINGS_TAB_IDS)

/** Query key holding the selected Meetings list tab. */
export const MEETINGS_TAB_QUERY = 'tab'

/** Query key holding the detail's return origin tab. */
export const MEETINGS_FROM_QUERY = 'from'

/**
 * Resolve a `tab` (or `from`) query value into a canonical
 * Meetings tab. Missing or unknown values fall back to Upcoming;
 * resolution is pure — it never rewrites the URL.
 */
export function meetingsTabFromParam(
  value: string | null,
): MeetingsTabId {
  return value != null && MEETINGS_TAB_SET.has(value)
    ? (value as MeetingsTabId)
    : 'upcoming'
}

/**
 * The canonical Meetings list location for a tab: Upcoming is the
 * bare /meetings; the other tabs carry their `tab` query.
 */
export function meetingsTabLocation(
  tab: MeetingsTabId,
): string {
  return tab === 'upcoming'
    ? '/meetings'
    : `/meetings?${MEETINGS_TAB_QUERY}=${tab}`
}

/**
 * The Meetings list destination a concrete Meeting detail returns
 * to, validated from the `from` value on its own URL. Only known
 * tab identifiers are honored; everything else falls back safely
 * to /meetings.
 */
export function meetingsListReturnDestination(
  from: string | null,
): string {
  return meetingsTabLocation(
    meetingsTabFromParam(from),
  )
}

/**
 * The concrete Meeting detail location for a row opened from a
 * Meetings list tab: Upcoming keeps the canonical bare detail URL;
 * the other tabs carry the validated origin so the detail's return
 * restores exactly that tab.
 */
export function meetingsDetailLocation(
  meetingId: number | string,
  originTab?: MeetingsTabId,
): string {
  const base = `/meetings/${meetingId}`

  return originTab == null ||
    originTab === 'upcoming'
    ? base
    : `${base}?${MEETINGS_FROM_QUERY}=${originTab}`
}
