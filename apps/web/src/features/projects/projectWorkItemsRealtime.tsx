import { useEffect, useRef } from 'react'

import {
  useWorkItemEventStream,
  type WorkItemEventStreamStatus,
} from '../../api/work-item-events'

/**
 * RT-04B — Project Board realtime lifecycle adapter.
 *
 * Renders nothing. It owns the Project Work Items surface's slice of
 * the canonical Work Item invalidation stream (RT-04A): the stream is
 * open exactly while this component is mounted — i.e. only for an
 * authenticated session (the hook's session gate) on the active
 * Project Work Items surface — and is closed on surface leave and
 * unmount. There is no second reconnection implementation and no
 * global EventSource singleton: reconnection (RC-1…RC-4) is entirely
 * the RT-04A controller's job.
 *
 * Callback wiring (all consumption-side bookkeeping stays on the
 * page, which owns the optimistic-drop guards):
 *
 * - `work_item_changed` is forwarded ONLY when the event's
 *   `projectId` is the Project currently open on this surface;
 *   foreign Projects are ignored. The event carries no Work Item
 *   data and none is derived client-side — the page answers with the
 *   canonical silent revalidation (`GET /api/projects/{id}/work-items/`).
 * - Every valid `open` handshake (initial connect, native reconnect,
 *   controlled reconnect) requests one authoritative revalidation —
 *   RC-5. The controller guarantees exactly one `onOpen` per
 *   connection, so one handshake never doubles the refetch.
 * - `my_work_changed` is deliberately NOT wired in this slice
 *   (RT-05).
 *
 * The stream's connection state is reported upward for the subdued,
 * non-blocking sync-paused display (degraded mode).
 */
export function ProjectWorkItemsRealtime({
  projectId,
  onInvalidation,
  onStreamStatus,
}: {
  /** The id of the Project whose Work Items surface is open. */
  projectId: number
  /**
   * Request one canonical, silent revalidation of the open Project's
   * Work Items (the page coalesces requests that arrive while a
   * fetch is in flight or a Board drop is pending).
   */
  onInvalidation: () => void
  /** Reports the stream's connection state (sync-paused display). */
  onStreamStatus?: (status: WorkItemEventStreamStatus) => void
}) {
  // The callbacks always act on the CURRENT surface context: the
  // stream lives across Project switches (same page instance), so
  // the open Project id and the page callbacks are read through
  // refs instead of being baked into the hook's stable callback
  // wiring.
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId

  const onInvalidationRef = useRef(onInvalidation)
  onInvalidationRef.current = onInvalidation

  const onStreamStatusRef = useRef(onStreamStatus)
  onStreamStatusRef.current = onStreamStatus

  // The hook reports the connection state through its return
  // value (the controller's own bookkeeping — RC-1…RC-4 stay
  // untouched); the surface consumes it here.
  const status = useWorkItemEventStream({
    // RC-5: the open surface authoritatively revalidates on every
    // successful (re)connection.
    onOpen: () => onInvalidationRef.current(),
    onWorkItemChanged: ({ projectId: changedProjectId }) => {
      if (changedProjectId !== projectIdRef.current) {
        return
      }

      onInvalidationRef.current()
    },
  })

  useEffect(() => {
    onStreamStatusRef.current?.(status)
  }, [status])

  return null
}
