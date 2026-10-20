import { useEffect, useRef } from 'react'

import {
  useWorkItemEventStream,
  type WorkItemEventStreamStatus,
} from '../../api/work-item-events'

/**
 * RT-05 — My Work realtime lifecycle adapter.
 *
 * Renders nothing. It owns the My Work surface's slice of the
 * canonical Work Item invalidation stream (RT-04A): the stream is
 * open exactly while this component is mounted — i.e. only on the
 * mounted My Work page with an authenticated session (the hook's
 * session gate) — and is closed on page unmount, logout, and
 * session loss. There is no second reconnection implementation
 * (RC-1…RC-4 are the untouched RT-04A controller's job) and no
 * global EventSource singleton.
 *
 * Callback wiring (all consumption-side bookkeeping stays on the
 * page, which owns the request-sequence and pending-move guards):
 *
 * - `my_work_changed` requests one authoritative, SILENT refetch of
 *   `GET /api/me/work-items/` (persisted preferences untouched).
 *   The event carries no Work Item data and none is derived
 *   client-side.
 * - Every valid `open` handshake (initial connect, native
 *   reconnect, controlled reconnect) requests the same revalidation
 *   — RC-5. The controller guarantees exactly one `onOpen` per
 *   connection, so one handshake never doubles the refetch.
 * - `work_item_changed` is deliberately NOT wired: My Work is not a
 *   per-Project surface; project-scope invalidations stay with the
 *   Project Work Items surface (RT-04B).
 *
 * The page coalesces the forwarded invalidations: a request that
 * arrives while an items fetch is in flight or a personal board
 * move is pending is held and re-requested exactly once when the
 * surface is quiescent again.
 *
 * The stream's connection state is reported upward for the subdued,
 * non-blocking sync-paused display (degraded mode).
 */
export function MyWorkRealtime({
  onInvalidation,
  onStreamStatus,
}: {
  /**
   * Request one canonical, silent revalidation of My Work
   * (`GET /api/me/work-items/` only — never the preferences).
   * The page coalesces requests that arrive while a fetch is in
   * flight or a personal board move is pending.
   */
  onInvalidation: () => void
  /** Reports the stream's connection state (sync-paused display). */
  onStreamStatus?: (status: WorkItemEventStreamStatus) => void
}) {
  // The callbacks always act on the CURRENT page context: the refs
  // keep the hook's stable callback wiring fresh across renders.
  const onInvalidationRef = useRef(onInvalidation)
  onInvalidationRef.current = onInvalidation

  const onStreamStatusRef = useRef(onStreamStatus)
  onStreamStatusRef.current = onStreamStatus

  // The hook reports the connection state through its return value
  // (the controller's own bookkeeping — RC-1…RC-4 stay untouched);
  // the surface consumes it here.
  const status = useWorkItemEventStream({
    // RC-5: the open surface authoritatively revalidates on every
    // successful (re)connection.
    onOpen: () => onInvalidationRef.current(),
    // The personal invalidation: one authoritative refetch of the
    // canonical personal projection (the page coalesces).
    onMyWorkChanged: () => onInvalidationRef.current(),
  })

  useEffect(() => {
    onStreamStatusRef.current?.(status)
  }, [status])

  return null
}
