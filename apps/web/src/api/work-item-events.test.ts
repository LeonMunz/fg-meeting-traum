import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { me } from './auth'
import { ApiError } from './client'
import type { ApiUser } from './types'
import {
  createWorkItemEventStream,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  WORK_ITEM_EVENTS_URL,
} from './work-item-events'
import type {
  WorkItemEventStream,
  WorkItemEventStreamCallbacks,
  WorkItemEventStreamOpen,
  WorkItemEventStreamSession,
  WorkItemEventStreamStatus,
  WorkItemEventStreamWorkItemChanged,
} from './work-item-events'

vi.mock('./auth', () => ({
  me: vi.fn(),
}))

const API_USER: ApiUser = {
  id: 1,
  username: 'alice',
  firstName: 'Alice',
  lastName: 'Lindqvist',
  email: 'alice@example.com',
}

/* ── Mock EventSource ──────────────────────────────────────────── */

interface MockEvent {
  type: string
  data?: string
  [key: string]: unknown
}

type MockListener = (event: MockEvent) => void

class MockEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2

  static instances: MockEventSource[] = []

  url: string
  withCredentials: boolean
  readyState: number
  closed: boolean
  listeners: Map<string, Set<MockListener>>

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url
    this.withCredentials = init?.withCredentials ?? false
    this.readyState = MockEventSource.CONNECTING
    this.closed = false
    this.listeners = new Map()
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: MockListener): void {
    let set = this.listeners.get(type)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: MockListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    this.closed = true
    this.readyState = MockEventSource.CLOSED
  }

  /** Test helper: dispatch one event to the registered listeners. */
  fire(type: string, data?: string, extra: Record<string, unknown> = {}): void {
    const event: MockEvent = { type, ...extra }
    if (data !== undefined) event.data = data
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

/* ── Harness helpers ───────────────────────────────────────────── */

interface MakeStreamOptions {
  authenticated?: boolean
  onOpen?: (open: WorkItemEventStreamOpen) => void
  onWorkItemChanged?: (event: WorkItemEventStreamWorkItemChanged) => void
  onMyWorkChanged?: () => void
  onStatusChange?: (status: WorkItemEventStreamStatus) => void
}

function makeStream(options: MakeStreamOptions = {}) {
  const callbacks: WorkItemEventStreamCallbacks = {
    onOpen: vi.fn(),
    onWorkItemChanged: vi.fn(),
    onMyWorkChanged: vi.fn(),
    onStatusChange: vi.fn(),
    ...options,
  }
  const isAuthenticated = vi.fn().mockReturnValue(options.authenticated ?? true)
  const onAuthenticationLost = vi.fn()
  const session: WorkItemEventStreamSession = {
    isAuthenticated,
    onAuthenticationLost,
  }
  const stream = createWorkItemEventStream({ session, callbacks })
  return { stream, session, callbacks, isAuthenticated, onAuthenticationLost }
}

/** Simulate a successful (re)connection: transport open + handshake frame. */
function openHandshake(source: MockEventSource, userId = API_USER.id): void {
  source.readyState = MockEventSource.OPEN
  source.fire('open', JSON.stringify({ userId }))
}

function terminalError(
  source: MockEventSource,
  extra: Record<string, unknown> = {},
): void {
  source.readyState = MockEventSource.CLOSED
  source.fire('error', undefined, extra)
}

function connectingError(source: MockEventSource): void {
  source.readyState = MockEventSource.CONNECTING
  source.fire('error')
}

function lastInstance(): MockEventSource {
  const instances = MockEventSource.instances
  return instances[instances.length - 1]!
}

/** Let in-flight promise chains run without advancing the clock. */
async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
}

/** RC-3: the deterministic delay for controlled attempt n at jitter r. */
function expectedDelayMs(n: number, jitter: number): number {
  const cap = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * 2 ** (n - 1),
  )
  return jitter * cap
}

beforeEach(() => {
  vi.useFakeTimers()
  MockEventSource.instances = []
  vi.mocked(me).mockReset().mockResolvedValue(API_USER)
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  vi.stubGlobal('EventSource', MockEventSource)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/* ── Lifecycle: start / stop ───────────────────────────────────── */

describe('Work Item event stream controller — lifecycle', () => {
  it('opens exactly one EventSource on an authenticated start', () => {
    const { stream, session } = makeStream()
    stream.start()

    expect(MockEventSource.instances).toHaveLength(1)
    const source = MockEventSource.instances[0]!
    expect(source.url).toBe(WORK_ITEM_EVENTS_URL)
    expect(source.withCredentials).toBe(true)
    // The session gate ran; the fresh auth check is only a recovery thing.
    expect(session.isAuthenticated).toHaveBeenCalledTimes(1)
    expect(me).not.toHaveBeenCalled()
    expect(stream.getStatus()).toBe('connecting')
  })

  it('starts nothing when no authenticated session exists', () => {
    const { stream, session } = makeStream({ authenticated: false })
    stream.start()

    expect(MockEventSource.instances).toHaveLength(0)
    expect(me).not.toHaveBeenCalled()
    expect(stream.getStatus()).toBe('idle')
    expect(session.onAuthenticationLost).not.toHaveBeenCalled()
  })

  it('start is idempotent and stop is terminal (unique lifecycle)', () => {
    const { stream } = makeStream()
    stream.start()
    stream.start()
    expect(MockEventSource.instances).toHaveLength(1)

    const source = lastInstance()
    expect(() => source.fire('error')).not.toThrow()
    stream.stop()

    expect(source.closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(stream.getStatus()).toBe('idle')

    // stop is idempotent; a stopped controller never starts again.
    stream.stop()
    stream.start()
    expect(MockEventSource.instances).toHaveLength(1)
    expect(me).not.toHaveBeenCalled()
  })
})

/* ── RC-1: native reconnect ────────────────────────────────────── */

describe('RC-1 — native reconnect for regular interruptions', () => {
  it('keeps the same instance on a CONNECTING interruption: no timer, no new instance, no auth check', async () => {
    const { stream, callbacks } = makeStream()
    stream.start()
    const source = MockEventSource.instances[0]!
    openHandshake(source)
    expect(stream.getStatus()).toBe('connected')

    connectingError(source)

    // The SAME instance is kept for the native reconnection.
    expect(MockEventSource.instances).toHaveLength(1)
    expect(MockEventSource.instances[0]).toBe(source)
    // No client-side recovery is layered on top of the native retry.
    expect(vi.getTimerCount()).toBe(0)
    expect(me).not.toHaveBeenCalled()
    expect(stream.getStatus()).toBe('reconnecting')

    // The native reconnection is observed through the SAME instance.
    openHandshake(source)
    expect(MockEventSource.instances).toHaveLength(1)
    expect(stream.getStatus()).toBe('connected')
    expect(callbacks.onOpen).toHaveBeenCalledTimes(2)
  })
})

/* ── RC-2: controlled reconnect for terminal failure ──────────── */

describe('RC-2 — controlled reconnect for terminal failure', () => {
  it('on CLOSED issues the fresh auth check first, then constructs exactly one new EventSource after the backoff', async () => {
    const statuses: WorkItemEventStreamStatus[] = []
    const { stream } = makeStream({
      onStatusChange: (status) => statuses.push(status),
    })
    stream.start()
    const first = MockEventSource.instances[0]!
    openHandshake(first)

    terminalError(first)

    // The fresh check goes out BEFORE any new instance is constructed.
    expect(me).toHaveBeenCalledTimes(1)
    expect(MockEventSource.instances).toHaveLength(1)
    expect(stream.getStatus()).toBe('reconnecting')

    await flushMicrotasks()
    // The controlled attempt waits the backoff (jitter 0.5 → 500 ms).
    await vi.advanceTimersByTimeAsync(499)
    expect(MockEventSource.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(MockEventSource.instances).toHaveLength(2)
    const second = MockEventSource.instances[1]!
    expect(second).not.toBe(first)
    expect(second.readyState).toBe(MockEventSource.CONNECTING)
    expect(stream.getStatus()).toBe('connecting')

    // The closed instance is dropped and never reused: no further
    // listeners are attached to it and nothing is constructed from it.
    const firstListenerCount = (type: string) => first.listeners.get(type)?.size ?? 0
    expect(firstListenerCount('open')).toBe(1)
    expect(firstListenerCount('error')).toBe(1)

    openHandshake(second)
    expect(MockEventSource.instances).toHaveLength(2)
    expect(stream.getStatus()).toBe('connected')
    expect(statuses).toEqual([
      'connecting',
      'connected',
      'reconnecting',
      'connecting',
      'connected',
    ])
  })
})

/* ── RC-3: backoff bounds ──────────────────────────────────────── */

describe('RC-3 — exponential backoff with jitter and cap', () => {
  it('controlled delays grow exponentially up to the 30 s cap', async () => {
    const { stream } = makeStream()
    stream.start()
    let current = MockEventSource.instances[0]!
    openHandshake(current)

    // A sustained outage: every new instance fails terminally BEFORE
    // its open handshake, so the counter keeps growing.
    for (let n = 1; n <= 7; n++) {
      terminalError(current)
      await flushMicrotasks()
      const delay = expectedDelayMs(n, 0.5)
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(MockEventSource.instances).toHaveLength(n)
      await vi.advanceTimersByTimeAsync(1)
      expect(MockEventSource.instances).toHaveLength(n + 1)
      current = MockEventSource.instances[n]!
    }
    // n=6 and n=7 already sit at the 30 s cap (1500 ms at jitter 0.5).
    expect(expectedDelayMs(6, 0.5)).toBe(15_000)
    expect(expectedDelayMs(7, 0.5)).toBe(15_000)
    // No further attempt is in flight: the last instance is simply down.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('the jittered delay stays within [0, cap] of the current attempt', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { stream } = makeStream()
    stream.start()
    const first = MockEventSource.instances[0]!
    openHandshake(first)
    terminalError(first)
    await flushMicrotasks()
    // Jitter 0 → delay 0 → the attempt fires without any wait.
    expect(MockEventSource.instances).toHaveLength(2)
  })

  it('near-maximum jitter waits almost the full cap of the attempt', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9999)
    const { stream } = makeStream()
    stream.start()
    const first = MockEventSource.instances[0]!
    openHandshake(first)
    terminalError(first)
    await flushMicrotasks()
    const delay = expectedDelayMs(1, 0.9999) // ≈ 999.9 ms
    await vi.advanceTimersByTimeAsync(Math.floor(delay) - 1)
    expect(MockEventSource.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(MockEventSource.instances).toHaveLength(2)
  })

  it('native retries do not advance the controlled-attempt counter', async () => {
    const { stream } = makeStream()
    stream.start()
    const source = MockEventSource.instances[0]!
    openHandshake(source)

    connectingError(source)
    connectingError(source)

    terminalError(source)
    await flushMicrotasks()
    // The first controlled attempt still waits the attempt-1 delay.
    await vi.advanceTimersByTimeAsync(expectedDelayMs(1, 0.5) - 1)
    expect(MockEventSource.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(MockEventSource.instances).toHaveLength(2)
  })

  it('resets the attempt counter after a successful open handshake', async () => {
    const { stream } = makeStream()
    stream.start()
    let current = MockEventSource.instances[0]!
    openHandshake(current)
    terminalError(current)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(expectedDelayMs(1, 0.5))
    current = MockEventSource.instances[1]!
    terminalError(current)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(expectedDelayMs(2, 0.5))
    current = MockEventSource.instances[2]!
    openHandshake(current)

    // After the handshake the sequence restarts at attempt 1.
    terminalError(current)
    await flushMicrotasks()
    const delay = expectedDelayMs(1, 0.5)
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(MockEventSource.instances).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(MockEventSource.instances).toHaveLength(4)
  })
})

/* ── RC-4: fresh auth check, no invalid-session loop ──────────── */

describe('RC-4 — fresh auth check, no invalid-session loop', () => {
  it('a 401 from the fresh check ends all reconnects and invalidates the local session', async () => {
    const { stream, session } = makeStream()
    stream.start()
    const source = MockEventSource.instances[0]!
    openHandshake(source)
    vi.mocked(me).mockRejectedValueOnce(new ApiError(401, null))

    terminalError(source)
    await flushMicrotasks()

    expect(session.onAuthenticationLost).toHaveBeenCalledTimes(1)
    // No new EventSource is constructed and no further attempt is scheduled.
    expect(MockEventSource.instances).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(stream.getStatus()).toBe('idle')

    await vi.advanceTimersByTimeAsync(365 * 24 * 3_600_000)
    expect(MockEventSource.instances).toHaveLength(1)
    expect(me).toHaveBeenCalledTimes(1)
    expect(session.onAuthenticationLost).toHaveBeenCalledTimes(1)
  })

  it('a network failure on the fresh check does not log out and repeats the check before the next attempt', async () => {
    const { stream, session } = makeStream()
    stream.start()
    const source = MockEventSource.instances[0]!
    openHandshake(source)
    vi.mocked(me)
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(API_USER)

    terminalError(source)
    await flushMicrotasks()

    expect(session.onAuthenticationLost).not.toHaveBeenCalled()
    expect(me).toHaveBeenCalledTimes(1)
    // Attempt 1 backoff, then the repeated fresh check.
    await vi.advanceTimersByTimeAsync(expectedDelayMs(1, 0.5))
    expect(me).toHaveBeenCalledTimes(2)
    // The valid check proceeds under the backoff (attempt 2).
    await vi.advanceTimersByTimeAsync(expectedDelayMs(2, 0.5))
    expect(MockEventSource.instances).toHaveLength(2)
    expect(stream.getStatus()).toBe('connecting')
  })

  it('a 5xx on the fresh check does not log out and keeps the recovery loop inconclusive', async () => {
    const { stream, session } = makeStream()
    stream.start()
    const source = MockEventSource.instances[0]!
    openHandshake(source)
    vi.mocked(me)
      .mockRejectedValueOnce(new ApiError(503, null))
      .mockRejectedValueOnce(new ApiError(500, null))
      .mockResolvedValueOnce(API_USER)

    terminalError(source)
    await flushMicrotasks()

    expect(session.onAuthenticationLost).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(expectedDelayMs(1, 0.5))
    expect(me).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(expectedDelayMs(2, 0.5))
    expect(me).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(expectedDelayMs(3, 0.5))
    expect(MockEventSource.instances).toHaveLength(2)
    expect(session.onAuthenticationLost).not.toHaveBeenCalled()
  })

  it('a locally unauthenticated session never starts recovery after a terminal error', async () => {
    const { stream, isAuthenticated } = makeStream()
    stream.start()
    const source = MockEventSource.instances[0]!
    openHandshake(source)

    // The session is lost (e.g. explicit logout) before the stream fails.
    isAuthenticated.mockReturnValue(false)
    terminalError(source)
    await flushMicrotasks()

    // No fresh check, no EventSource, no attempt.
    expect(me).not.toHaveBeenCalled()
    expect(MockEventSource.instances).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(stream.getStatus()).toBe('idle')
  })

  it('never infers an HTTP status from the onerror event', async () => {
    const { stream, session } = makeStream()
    stream.start()
    const source = MockEventSource.instances[0]!
    openHandshake(source)

    // The mock carries a bogus status the real EventSource never does.
    terminalError(source, { status: 401, statusText: 'Unauthorized' })
    await flushMicrotasks()

    // The bogus status is ignored: the fresh check is issued and its
    // own answer (200) drives the controlled reconnect.
    expect(session.onAuthenticationLost).not.toHaveBeenCalled()
    expect(me).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(expectedDelayMs(1, 0.5))
    expect(MockEventSource.instances).toHaveLength(2)
    expect(session.onAuthenticationLost).not.toHaveBeenCalled()
  })
})

/* ── Double errors: no parallel loops ──────────────────────────── */

describe('double error callbacks', () => {
  it('create no parallel reconnection loop', async () => {
    const { stream } = makeStream()
    stream.start()
    const source = MockEventSource.instances[0]!
    openHandshake(source)

    terminalError(source)
    terminalError(source)
    await flushMicrotasks()

    expect(me).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(expectedDelayMs(1, 0.5))
    expect(MockEventSource.instances).toHaveLength(2)

    // No second loop keeps running in the background.
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(MockEventSource.instances).toHaveLength(2)
    expect(me).toHaveBeenCalledTimes(1)
  })
})

/* ── Stop / session change: no late reconnects ────────────────── */

describe('stop and session change prevent late reconnects', () => {
  function pendingMe() {
    let resolveMe: ((user: ApiUser) => void) | undefined
    vi.mocked(me).mockImplementationOnce(
      () =>
        new Promise<ApiUser>((resolve) => {
          resolveMe = resolve
        }),
    )
    return {
      resolve: (user: ApiUser) => {
        resolveMe?.(user)
      },
    }
  }

  it('stop while the fresh auth check is in flight prevents a late reconnect', async () => {
    const { stream } = makeStream()
    stream.start()
    const source = MockEventSource.instances[0]!
    openHandshake(source)
    const { resolve } = pendingMe()

    terminalError(source)
    await flushMicrotasks()
    expect(me).toHaveBeenCalledTimes(1)

    stream.stop()
    resolve(API_USER)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)

    expect(MockEventSource.instances).toHaveLength(1)
    expect(stream.getStatus()).toBe('idle')
  })

  it('stop while the backoff wait is pending prevents a late reconnect', async () => {
    const { stream } = makeStream()
    stream.start()
    const source = MockEventSource.instances[0]!
    openHandshake(source)

    terminalError(source)
    await flushMicrotasks()
    expect(vi.getTimerCount()).toBe(1)

    stream.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)

    expect(MockEventSource.instances).toHaveLength(1)
    expect(stream.getStatus()).toBe('idle')
  })

  it('a session change while recovery is pending prevents a late reconnect', async () => {
    const { stream, isAuthenticated } = makeStream()
    stream.start()
    const source = MockEventSource.instances[0]!
    openHandshake(source)
    const { resolve } = pendingMe()

    terminalError(source)
    await flushMicrotasks()

    // The local session state is lost while the check is in flight.
    isAuthenticated.mockReturnValue(false)
    resolve(API_USER)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)

    // The valid check result must not create a new connection.
    expect(MockEventSource.instances).toHaveLength(1)
    expect(stream.getStatus()).toBe('idle')
  })
})

/* ── open handshake: exactly one callback per connection ──────── */

describe('open handshake', () => {
  it('fires exactly one onOpen per successful connection', async () => {
    const { stream, callbacks } = makeStream()
    stream.start()
    const source = MockEventSource.instances[0]!

    // The transport-level open event carries no data: not a handshake.
    source.readyState = MockEventSource.OPEN
    source.fire('open')
    expect(callbacks.onOpen).not.toHaveBeenCalled()
    expect(stream.getStatus()).toBe('connecting')

    openHandshake(source)
    expect(callbacks.onOpen).toHaveBeenCalledTimes(1)
    expect(callbacks.onOpen).toHaveBeenCalledWith({ userId: API_USER.id })
    expect(stream.getStatus()).toBe('connected')

    // A duplicated handshake frame on the same connection is ignored.
    source.fire('open', JSON.stringify({ userId: API_USER.id }))
    expect(callbacks.onOpen).toHaveBeenCalledTimes(1)

    // A native reconnect is a second connection → exactly one more call.
    connectingError(source)
    openHandshake(source)
    expect(callbacks.onOpen).toHaveBeenCalledTimes(2)
  })
})

/* ── Event forwarding (minimal invalidation hints) ────────────── */

describe('event forwarding', () => {
  it('forwards project and My Work invalidations correctly and minimally', () => {
    const { stream, callbacks } = makeStream()
    stream.start()
    const source = MockEventSource.instances[0]!
    openHandshake(source)

    source.fire('work_item_changed', JSON.stringify({ projectId: 42 }))
    expect(callbacks.onWorkItemChanged).toHaveBeenCalledTimes(1)
    expect(callbacks.onWorkItemChanged).toHaveBeenCalledWith({ projectId: 42 })

    source.fire('my_work_changed', JSON.stringify({}))
    expect(callbacks.onMyWorkChanged).toHaveBeenCalledTimes(1)
    expect(callbacks.onMyWorkChanged).toHaveBeenCalledWith()

    source.fire('work_item_changed', JSON.stringify({ projectId: 7 }))
    source.fire('my_work_changed', JSON.stringify({}))
    expect(callbacks.onWorkItemChanged).toHaveBeenLastCalledWith({ projectId: 7 })
    expect(callbacks.onMyWorkChanged).toHaveBeenCalledTimes(2)
  })

  it('drops invalid event payloads without side effects', () => {
    const { stream, callbacks } = makeStream()
    stream.start()
    const source = MockEventSource.instances[0]!

    // Invalid open payloads: no handshake, still connecting.
    source.readyState = MockEventSource.OPEN
    source.fire('open', JSON.stringify({ userId: '7' }))
    source.fire('open', JSON.stringify({ userId: 7, extra: true }))
    source.fire('open', JSON.stringify(null))
    expect(callbacks.onOpen).not.toHaveBeenCalled()
    expect(stream.getStatus()).toBe('connecting')

    openHandshake(source)
    expect(callbacks.onOpen).toHaveBeenCalledTimes(1)

    // Invalid work_item_changed payloads: all dropped.
    source.fire('work_item_changed', JSON.stringify({ projectId: '42' }))
    source.fire('work_item_changed', JSON.stringify({ projectId: 42.5 }))
    source.fire('work_item_changed', JSON.stringify({ projectId: 42, workItemIds: [1, 2] }))
    source.fire('work_item_changed', JSON.stringify({ workItemId: 9 }))
    source.fire('work_item_changed', '{"projectId": 42')
    source.fire('work_item_changed', JSON.stringify([42]))
    source.fire('work_item_changed', JSON.stringify(null))
    expect(callbacks.onWorkItemChanged).not.toHaveBeenCalled()

    // Invalid my_work_changed payloads: Work Item data is never forwarded.
    source.fire('my_work_changed', JSON.stringify({ workItemId: 5 }))
    source.fire('my_work_changed', JSON.stringify({ projectId: 1 }))
    expect(callbacks.onMyWorkChanged).not.toHaveBeenCalled()

    // A valid event still flows after the invalid ones.
    source.fire('work_item_changed', JSON.stringify({ projectId: 3 }))
    expect(callbacks.onWorkItemChanged).toHaveBeenCalledTimes(1)
    expect(callbacks.onWorkItemChanged).toHaveBeenCalledWith({ projectId: 3 })
  })
})

/* ── Connection state for the sync-paused presentation ────────── */

describe('connection state', () => {
  it('tracks the state transitions for the later sync-paused display', async () => {
    const statuses: WorkItemEventStreamStatus[] = []
    const { stream } = makeStream({
      onStatusChange: (status) => statuses.push(status),
    })
    stream.start()
    const source = MockEventSource.instances[0]!
    openHandshake(source)
    connectingError(source)
    openHandshake(source)
    terminalError(source)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(expectedDelayMs(1, 0.5))
    openHandshake(lastInstance())
    stream.stop()

    expect(statuses).toEqual([
      'connecting',
      'connected',
      'reconnecting',
      'connected',
      'reconnecting',
      'connecting',
      'connected',
      'idle',
    ])
  })
})

/* ── Type-level smoke: the controller surface is stable ───────── */

describe('controller surface', () => {
  it('exposes start/stop/getStatus', () => {
    const { stream } = makeStream()
    expect(typeof stream.start).toBe('function')
    expect(typeof stream.stop).toBe('function')
    expect(stream.getStatus()).toBe('idle')
    const streamRef: WorkItemEventStream = stream
    expect(streamRef).toBeDefined()
  })
})
