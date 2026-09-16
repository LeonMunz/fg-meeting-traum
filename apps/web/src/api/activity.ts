import { apiGet } from './client'

import type { ApiActivityEvent } from './types'

/**
 * The aggregate Activity feed: a reverse-chronological,
 * permission-filtered page of structured Activity events. The response
 * is a bare array (no total count). `limit` is bounded 1..100 by the
 * backend; the Home rail requests a small, compact page.
 */
export async function listActivityFeed(
  limit = 20,
): Promise<ApiActivityEvent[]> {
  return apiGet<ApiActivityEvent[]>(
    `/api/activity/?limit=${limit}`,
  )
}
