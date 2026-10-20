/**
 * Reusable client transport for the canonical Work Item invalidation
 * stream (`GET /api/work-items/events/`).
 *
 * This module owns the browser `EventSource` for the realtime surface and
 * implements the documented recovery contract
 * (`docs/architecture.md`, Realtime → "Recovery contract"):
 *
 * - RC-1 — a connection-level interruption (`readyState` CONNECTING) is
 *   recovered by the native `EventSource` reconnection of the SAME
 *   instance: no new instance, no client-side timer, no auth check.
 * - RC-2 — a terminal failure (`readyState` CLOSED) drops the closed
 *   instance (never reused) and schedules a controlled reconnect that
 *   constructs exactly one new `EventSource` after the backoff wait.
 * - RC-3 — controlled attempts are spaced by exponential backoff with
 *   jitter: attempt n (n >= 1) waits a uniform delay in
 *   `[0, min(cap, base * 2^(n-1))]` with base 1 s and cap 30 s. The
 *   counter counts controlled attempts only (native retries do not
 *   advance it) and resets on the `open` handshake.
 * - RC-4 — the stream's `error` event carries no usable HTTP status and
 *   is never interpreted as one. Every controlled attempt is gated by a
 *   fresh `GET /api/auth/me/` check: a 401 from the check ends all
 *   reconnects and reports the authentication loss to the session; 200
 *   proceeds under the backoff; a network error or any other status is
 *   inconclusive (no logout, the check repeats before the next attempt).
 *   While the app's local session state is unauthenticated, no
 *   `EventSource` is created and no check is issued.
 *
 * Events are strictly validated and forwarded as minimal invalidation
 * hints only: `open` (own `userId`), `work_item_changed` (`projectId`),
 * `my_work_changed` (no Work Item data). The controller never applies
 * state from event data and never reconstructs server-side permissions
 * client-side — authorization stays authoritative on the server.
 *
 * The controller is framework-free and session-coupled: it only runs
 * while an authenticated session exists (see the `useWorkItemEventStream`
 * hook below) and its `stop()` is terminal — a new session receives a
 * new controller. Board surfaces (Project Board in RT-04B, My Work in
 * RT-05) register callbacks on the controller; the authoritative refetch
 * on each open handshake (RC-5) is wired there, not in this transport.
 */

import { useEffect, useRef, useState } from 'react'

import { me } from './auth'
import { ApiError } from './client'
import { useSession } from './useSession'

/** Canonical stream endpoint (same-origin; session cookies travel with it). */
export const WORK_ITEM_EVENTS_URL = '/api/work-items/events/'

/** RC-3 contract constants (`docs/architecture.md`, Realtime → backoff). */
export const RECONNECT_BASE_DELAY_MS = 1_000
export const RECONNECT_MAX_DELAY_MS = 30_000

/**
 * Connection state for the later subdued sync-paused presentation:
 * - `idle` — no stream (never started, stopped, or unauthenticated)
 * - `connecting` — an `EventSource` is waiting for the `open` handshake
 * - `connected` — the `open` handshake was observed
 * - `reconnecting` — the stream is down (native retry in flight or
 *   controlled backoff wait)
 */
export type WorkItemEventStreamStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'

export interface WorkItemEventStreamOpen {
  /** The stream's own user id (the authenticated user). */
  userId: number
}

export interface WorkItemEventStreamWorkItemChanged {
  /** The affected Project id — no Work Item data is carried. */
  projectId: number
}

export interface WorkItemEventStreamCallbacks {
  /**
   * Exactly one call per successful (re)connection, after the valid
   * `open` handshake. This is the technical basis for RC-5 (the
   * authoritative refetch is performed by the consuming surface).
   */
  onOpen?: (open: WorkItemEventStreamOpen) => void
  /** A validated project-scope invalidation hint. */
  onWorkItemChanged?: (event: WorkItemEventStreamWorkItemChanged) => void
  /** A validated personal-scope invalidation hint (no Work Item data). */
  onMyWorkChanged?: () => void
  /** Connection state for the later sync-paused presentation. */
  onStatusChange?: (status: WorkItemEventStreamStatus) => void
}

/**
 * Minimal session port: the controller reads the app's LOCAL session
 * state and reports an authentication loss back to it (RC-4). It never
 * authenticates by itself and never infers session state from the
 * stream error.
 */
export interface WorkItemEventStreamSession {
  isAuthenticated: () => boolean
  onAuthenticationLost: () => void
}

export interface WorkItemEventStreamOptions {
  session: WorkItemEventStreamSession
  callbacks?: WorkItemEventStreamCallbacks
}

export interface WorkItemEventStream {
  /**
   * Start the stream. No-op when the stream was already started or
   * stopped (the lifecycle is unique per controller), and no-op when no
   * authenticated session exists (no `EventSource`, no auth check).
   */
  start(): void
  /**
   * Stop the stream: close the `EventSource`, remove its listeners, and
   * cancel the pending backoff timer and in-flight recovery. Terminal
   * for this controller and idempotent — a late auth-check result must
   * not create a new connection.
   */
  stop(): void
  /** Current connection state (see `WorkItemEventStreamStatus`). */
  getStatus(): WorkItemEventStreamStatus
}

/**
 * Create one Work Item event stream controller bound to one session.
 *
 * The controller is not a singleton and must not be created outside an
 * authenticated session: create one per session lifetime (the
 * `useWorkItemEventStream` hook does exactly that) and `stop()` it when
 * the session ends.
 */
export function createWorkItemEventStream(
  options: WorkItemEventStreamOptions,
): WorkItemEventStream {
  const session = options.session
  const callbacks = options.callbacks ?? {}

  let status: WorkItemEventStreamStatus = 'idle'
  let running = false
  let stopped = false
  let source: EventSource | null = null
  /**
   * Terminal-failure guard for the CURRENT instance: a closed instance
   * may schedule recovery at most once, so double error callbacks can
   * never create parallel reconnection loops.
   */
  let terminalHandled = false
  /** Handshake guard for the CURRENT instance: one `onOpen` per connection. */
  let handshakeSeen = false
  /**
   * Controlled (terminal-tier) attempts in the current failure sequence;
   * resets to 0 on the `open` handshake. Native retries never advance it.
   */
  let attempt = 0
  let backoffTimer: ReturnType<typeof setTimeout> | null = null

  function setStatus(next: WorkItemEventStreamStatus): void {
    if (status === next) return
    status = next
    callbacks.onStatusChange?.(next)
  }

  function isActive(): boolean {
    return running && !stopped
  }

  /** RC-3: uniform delay in `[0, min(cap, base * 2^(n-1))]`. */
  function backoffDelayMs(n: number): number {
    const cap = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** (n - 1),
    )
    return Math.random() * cap
  }

  function clearBackoffTimer(): void {
    if (backoffTimer !== null) {
      clearTimeout(backoffTimer)
      backoffTimer = null
    }
  }

  function detachSource(): void {
    if (source !== null) {
      source.removeEventListener('open', handleOpen)
      source.removeEventListener('work_item_changed', handleWorkItemChanged)
      source.removeEventListener('my_work_changed', handleMyWorkChanged)
      source.removeEventListener('error', handleSourceError)
      source.close()
    }
    source = null
    terminalHandled = false
    handshakeSeen = false
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    running = false
    clearBackoffTimer()
    detachSource()
    setStatus('idle')
  }

  function start(): void {
    if (stopped || running) return
    running = true
    // Session gate (RC-4): without a locally authenticated session there
    // is no stream, no fresh check, and no scheduled attempt.
    if (!session.isAuthenticated()) {
      setStatus('idle')
      return
    }
    connect()
  }

  function connect(): void {
    if (!isActive()) return
    // Same-origin session cookie is sent by the native EventSource; no
    // tokens are used.
    const next = new EventSource(WORK_ITEM_EVENTS_URL, {
      withCredentials: true,
    })
    source = next
    terminalHandled = false
    handshakeSeen = false
    next.addEventListener('open', handleOpen)
    next.addEventListener('work_item_changed', handleWorkItemChanged)
    next.addEventListener('my_work_changed', handleMyWorkChanged)
    next.addEventListener('error', handleSourceError)
    setStatus('connecting')
  }

  function handleSourceError(): void {
    const current = source
    if (current === null) return

    if (current.readyState === EventSource.CLOSED) {
      // RC-2/RC-3/RC-4 — terminal failure. Per the EventSource
      // specification the error event carries no usable HTTP status, so
      // nothing about the failure is inferred from it.
      if (terminalHandled) return // double error callback: no second loop
      terminalHandled = true
      // RC-2: drop the closed instance; it is never reused.
      source = null
      handshakeSeen = false
      if (!isActive()) return
      // Local session gate before any fresh check.
      if (!session.isAuthenticated()) {
        stop()
        return
      }
      setStatus('reconnecting')
      void runRecovery()
    } else {
      // RC-1 — connection-level interruption (readyState CONNECTING):
      // the native EventSource reconnection IS the recovery. Keep the
      // same instance, schedule no timer, issue no auth check. The
      // re-established stream sends a fresh open handshake, which is
      // counted as the next successful connection (RC-5 basis).
      handshakeSeen = false
      setStatus('reconnecting')
    }
  }

  async function runRecovery(): Promise<void> {
    if (!isActive()) return
    if (!session.isAuthenticated()) {
      stop()
      return
    }
    // RC-4 auth gate: a fresh check against the same endpoint the app
    // recovers its session state from — issued before any new
    // EventSource is constructed.
    const result = await freshAuthCheck()
    if (!isActive()) return
    if (result === 'unauthenticated') {
      // RC-4: terminal authentication loss — end every reconnect and
      // hand the loss to the session (the local session state is cleared
      // there; no logout POST is issued to the invalid session).
      stop()
      session.onAuthenticationLost()
      return
    }
    // 'valid' or 'inconclusive': the next controlled attempt is spaced
    // by the backoff (RC-3); the new EventSource is only constructed
    // after the wait.
    attempt += 1
    backoffTimer = setTimeout(() => {
      backoffTimer = null
      if (!isActive()) return
      // Local session gate: a session change while the backoff was in
      // flight must not create a new connection.
      if (!session.isAuthenticated()) {
        stop()
        return
      }
      if (result === 'valid') {
        connect()
      } else {
        // Inconclusive check: no logout; the fresh check is repeated
        // before the next attempt.
        void runRecovery()
      }
    }, backoffDelayMs(attempt))
  }

  function handleOpen(event: Event): void {
    const current = source
    if (current === null || handshakeSeen) return
    if (current.readyState !== EventSource.OPEN) return
    const open = parseOpenPayload(event)
    if (open === null) return
    // A valid open handshake: the connection (re)established. Exactly
    // one callback per connection, and the controlled-attempt counter
    // resets (RC-3).
    handshakeSeen = true
    attempt = 0
    setStatus('connected')
    callbacks.onOpen?.(open)
  }

  function handleWorkItemChanged(event: Event): void {
    if (source === null) return
    const payload = parseEventObject(event, ['projectId'])
    if (payload === null) return
    const projectId = payload.projectId
    if (!isPositiveInteger(projectId)) return
    callbacks.onWorkItemChanged?.({ projectId })
  }

  function handleMyWorkChanged(event: Event): void {
    if (source === null) return
    // The personal invalidation carries no Work Item data: a payload
    // with any key at all violates the contract and is dropped.
    const payload = parseEventObject(event, [])
    if (payload === null) return
    callbacks.onMyWorkChanged?.()
  }

  return {
    start,
    stop,
    getStatus: () => status,
  }
}

/* ── Payload validation (strict, fail-closed) ──────────────────── */

function parseEventObject(
  event: Event,
  allowedKeys: readonly string[],
): Record<string, unknown> | null {
  const raw = (event as MessageEvent).data
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const object = parsed as Record<string, unknown>
  const keys = Object.keys(object)
  if (keys.length !== allowedKeys.length) return null
  for (const key of allowedKeys) {
    if (!(key in object)) return null
  }
  return object
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function parseOpenPayload(event: Event): WorkItemEventStreamOpen | null {
  const payload = parseEventObject(event, ['userId'])
  if (payload === null) return null
  const userId = payload.userId
  if (!isPositiveInteger(userId)) return null
  return { userId }
}

/* ── RC-4: fresh authentication check ──────────────────────────── */

type AuthCheckResult = 'valid' | 'unauthenticated' | 'inconclusive'

async function freshAuthCheck(): Promise<AuthCheckResult> {
  try {
    await me()
    return 'valid'
  } catch (error) {
    if (error instanceof ApiError) {
      // Only the check's own 401 is a terminal authentication loss.
      if (error.status === 401) return 'unauthenticated'
      // 5xx and any other non-200 answer: inconclusive, never a logout.
      return 'inconclusive'
    }
    // Network failure (or any non-ApiError): inconclusive, never a logout.
    return 'inconclusive'
  }
}

/* ── Session-coupled React lifecycle ───────────────────────────── */

/**
 * Session-coupled lifecycle for the Work Item event stream.
 *
 * Starts the controller while an authenticated session exists and stops
 * it on logout, session change, and unmount — so no stream ever runs
 * independently of the user session and no late auth-check result can
 * create a new connection after the session is gone. A new (re-)
 * authenticated session receives a fresh controller (stop is terminal
 * by design).
 *
 * Returns the current connection state for the later sync-paused
 * presentation; the consuming surface registers its callbacks (RC-5
 * refetch, invalidation handling) through `callbacks`.
 */
export function useWorkItemEventStream(
  callbacks: WorkItemEventStreamCallbacks = {},
): WorkItemEventStreamStatus {
  const { user, handleAuthenticationLost } = useSession()
  const [status, setStatus] = useState<WorkItemEventStreamStatus>('idle')

  // The controller outlives individual renders and must always see the
  // current callbacks and session without being restarted by them.
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks
  const userRef = useRef(user)
  userRef.current = user
  const onAuthenticationLostRef = useRef(handleAuthenticationLost)
  onAuthenticationLostRef.current = handleAuthenticationLost
  const streamRef = useRef<WorkItemEventStream | null>(null)

  const userId = user?.id ?? null

  useEffect(() => {
    if (userId === null) {
      // Unauthenticated: no stream and no auth check (RC-4 session gate).
      streamRef.current?.stop()
      streamRef.current = null
      setStatus('idle')
      return
    }

    const stream = createWorkItemEventStream({
      session: {
        isAuthenticated: () => userRef.current !== null,
        onAuthenticationLost: () => {
          onAuthenticationLostRef.current()
        },
      },
      callbacks: {
        onOpen: (open) => callbacksRef.current.onOpen?.(open),
        onWorkItemChanged: (event) =>
          callbacksRef.current.onWorkItemChanged?.(event),
        onMyWorkChanged: () => callbacksRef.current.onMyWorkChanged?.(),
        onStatusChange: (next) => setStatus(next),
      },
    })
    streamRef.current = stream
    stream.start()
    return () => {
      stream.stop()
      if (streamRef.current === stream) {
        streamRef.current = null
      }
    }
  }, [userId])

  return status
}
