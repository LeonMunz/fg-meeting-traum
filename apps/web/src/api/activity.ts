import { apiGet } from './client'

import type {
  ActivityDomain,
  ApiActivityEvent,
} from './types'

/**
 * The aggregate Activity feed: a reverse-chronological,
 * permission-filtered page of structured Activity events. The response
 * is a bare array (no total count). `limit` is bounded 1..100 by the
 * backend; the Home rail requests a small, compact page. An optional
 * `domains` strict subset narrows the feed server-side (OR
 * semantics); the absent parameter is the canonical all-domains
 * state and is never sent unnecessarily.
 */
/** Canonical Activity domain order: the deterministic serialization
 * order of the `?domains=` query values (never click order). */
export const ACTIVITY_DOMAINS: readonly ActivityDomain[] = [
  'work_item',
  'meeting',
  'project',
  'research_group',
]

export interface ListActivityFeedOptions {
  limit?: number
  /**
   * Strict subset of the canonical domains to include (resolved
   * server-side, OR semantics). Absent — or the full four — requests
   * the canonical unfiltered feed, so the `domains` parameter stays
   * off the wire.
   */
  domains?: ActivityDomain[]
}

export async function listActivityFeed(
  options: ListActivityFeedOptions = {},
): Promise<ApiActivityEvent[]> {
  const { limit = 20, domains } = options

  // Serialize only the recognized domains, in canonical order, so the
  // request never depends on the caller's selection order.
  const selected = domains
    ? ACTIVITY_DOMAINS.filter((domain) => domains.includes(domain))
    : []

  const domainsQuery =
    selected.length > 0 &&
    selected.length < ACTIVITY_DOMAINS.length
      ? `&domains=${selected.join(',')}`
      : ''

  return apiGet<ApiActivityEvent[]>(
    `/api/activity/?limit=${limit}${domainsQuery}`,
  )
}
