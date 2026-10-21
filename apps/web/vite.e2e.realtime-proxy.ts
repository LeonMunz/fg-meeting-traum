/**
 * E2E-only SSE disconnect harness for the local E2E topology.
 *
 * This module is imported EXCLUSIVELY by `vite.e2e.config.ts` (the
 * local E2E Vite server, bound to 127.0.0.1:4173). It is not part of
 * the product: the production `vite.config.ts` and the Django backend
 * are untouched, and the browser never receives a synthetic SSE frame,
 * event, or artificial authentication result — every response byte
 * the browser sees comes from Django.
 *
 * The harness takes over ONLY the authenticated Work Item event stream
 * path (`GET /api/work-items/events/`), proxies every such request to
 * the local Django server exactly like the ordinary `/api` proxy does,
 * and keeps a local registry of the live SSE connections it carries —
 * keyed by the Django session id of the connecting browser session
 * (the `sessionid` cookie value).
 *
 * The Playwright spec then controls, per session:
 *
 * - `POST /__e2e/realtime/disconnect` `{"sessionId": ...}`
 *   Severs EXACTLY the one live SSE connection of the named session
 *   (the client socket is torn down without any response — a
 *   connection-level interruption: no HTTP status, no synthetic
 *   frame, so the native EventSource takes the RC-1 `CONNECTING`
 *   path and can never be driven into the terminal `CLOSED` path)
 *   and arms the per-session hold.
 * - Hold (armed by the disconnect): every subsequent SSE connection
 *   attempt of the named session is accepted and kept PENDING with no
 *   response bytes at all — in particular no terminal HTTP error.
 *   Ordinary API requests (through the ordinary proxy) and every
 *   other session keep being served.
 * - `POST /__e2e/realtime/release` `{"sessionId": ...}`
 *   Forwards the pending attempt(s) to Django and clears the hold;
 *   the native connection establishment proceeds normally (the real
 *   200 `text/event-stream` and the real server `open` handshake flow
 *   through).
 * - `POST /__e2e/realtime/reset` `{"sessionId": ...}`
 *   Idempotent teardown: destroys every tracked connection of the
 *   session (streaming or held) and clears its hold.
 *
 * Fail-closed: `disconnect` answers 409 (and changes no state) when
 * the named session has zero or more than one live SSE connection;
 * `release` answers 409 when the named session is not on hold. The
 * control endpoints are reachable only on the loopback-bound E2E Vite
 * server, accept POST JSON only, and no cookie, session id, or secret
 * is ever logged or echoed back into a response.
 */

import http from 'node:http'
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from 'node:http'
import type { Plugin } from 'vite'

/** The local API origin the E2E Vite server proxies to (Django). */
export interface RealtimeDisconnectTarget {
  host: string
  port: number
}

/** The single authenticated SSE path this harness takes over. */
export const REALTIME_SSE_PATH = '/api/work-items/events/'

/**
 * Control endpoints (local E2E topology only; POST JSON only).
 * Bodies and responses carry no cookie, session id, or secret.
 */
export const REALTIME_CONTROL_PATHS = {
  disconnect: '/__e2e/realtime/disconnect',
  release: '/__e2e/realtime/release',
  reset: '/__e2e/realtime/reset',
} as const

const SESSION_COOKIE_NAME = 'sessionid'
const MAX_CONTROL_BODY_BYTES = 8 * 1024
const MAX_SESSION_ID_LENGTH = 256

/** Hop-by-hop headers never forwarded to or from the upstream. */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

type StreamState = 'streaming' | 'held'

/** One tracked SSE connection carried by the harness. */
interface TrackedStream {
  sessionId: string
  state: StreamState
  req: IncomingMessage
  res: ServerResponse
  upstream: ClientRequest | null
}

/** Create the E2E-only SSE disconnect plugin. */
export function e2eRealtimeDisconnectPlugin(
  target: RealtimeDisconnectTarget,
): Plugin {
  /** Every connection the harness currently carries. */
  const tracked = new Set<TrackedStream>()
  /** Sessions whose SSE attempts are currently held (no response). */
  const holdArmed = new Set<string>()
  /** Pending (held) SSE attempts per armed session. */
  const heldStreams = new Map<string, TrackedStream[]>()

  /**
   * The connecting session's Django session id (`sessionid` cookie
   * value), or null for anonymous / malformed requests.
   */
  function sessionIdOf(req: IncomingMessage): string | null {
    const header = req.headers.cookie
    if (typeof header !== 'string') return null
    for (const part of header.split(';')) {
      const eq = part.indexOf('=')
      if (eq <= 0) continue
      if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue
      const value = part.slice(eq + 1).trim()
      if (
        value.length > 0 &&
        value.length <= MAX_SESSION_ID_LENGTH
      ) {
        return value
      }
      return null
    }
    return null
  }

  function filterHeaders(
    headers: IncomingHttpHeaders,
  ): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(headers)) {
      if (name === 'host' || HOP_BY_HOP_HEADERS.has(name)) continue
      if (value === undefined) continue
      out[name] = value
    }
    out.host = `${target.host}:${target.port}`
    return out
  }

  function filterResponseHeaders(
    headers: IncomingHttpHeaders,
  ): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(headers)) {
      if (name === 'host' || HOP_BY_HOP_HEADERS.has(name)) continue
      if (value === undefined) continue
      out[name] = value
    }
    return out
  }

  function sendJson(
    res: ServerResponse,
    status: number,
    body: Record<string, string | number>,
  ): void {
    if (res.writableEnded) return
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  /**
   * Forward an accepted SSE request to Django. Before the upstream
   * answers, an upstream failure is surfaced as a plain 502 (exactly
   * like the ordinary proxy — a response-level failure, terminal for
   * the native EventSource); AFTER the response is flowing, an
   * upstream failure tears the client socket down (a connection-level
   * interruption).
   */
  function openUpstream(entry: TrackedStream): void {
    const upstream = http.request({
      host: target.host,
      port: target.port,
      method: entry.req.method ?? 'GET',
      path: entry.req.url ?? '/',
      headers: filterHeaders(entry.req.headers),
    })
    entry.upstream = upstream
    upstream.on('error', () => {
      if (!tracked.has(entry)) return
      tracked.delete(entry)
      if (entry.res.headersSent) {
        entry.res.destroy()
      } else {
        sendJson(entry.res, 502, {
          error: 'upstream unavailable',
        })
      }
    })
    upstream.on('response', (upstreamRes) => {
      entry.res.writeHead(
        upstreamRes.statusCode ?? 502,
        filterResponseHeaders(upstreamRes.headers),
      )
      upstreamRes.on('error', () => {
        if (tracked.has(entry)) tracked.delete(entry)
        entry.res.destroy()
      })
      upstreamRes.on('end', () => {
        if (tracked.has(entry)) tracked.delete(entry)
        if (!entry.res.writableEnded) entry.res.end()
      })
      upstreamRes.pipe(entry.res)
    })
    entry.req.pipe(upstream)
  }

  /** The client went away: drop the entry and the upstream. */
  function onClientGone(entry: TrackedStream): void {
    if (!tracked.has(entry)) return
    tracked.delete(entry)
    if (entry.state === 'held') {
      const list = heldStreams.get(entry.sessionId)
      if (list !== undefined) {
        const index = list.indexOf(entry)
        if (index !== -1) list.splice(index, 1)
      }
    }
    entry.upstream?.destroy()
  }

  /**
   * The taken-over SSE path: proxy it to Django like the ordinary
   * proxy, but track the connection per session (or hold it while
   * the session is on hold).
   */
  function handleSseRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    const sessionId = sessionIdOf(req)
    if (sessionId === null) {
      // Anonymous request: plain proxy — Django answers 401 before
      // any stream byte. Nothing to track, nothing to hold.
      const upstream = http.request({
        host: target.host,
        port: target.port,
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: filterHeaders(req.headers),
      })
      upstream.on('error', () => {
        if (!res.headersSent) {
          sendJson(res, 502, { error: 'upstream unavailable' })
        } else {
          res.destroy()
        }
      })
      upstream.on('response', (upstreamRes) => {
        res.writeHead(
          upstreamRes.statusCode ?? 502,
          filterResponseHeaders(upstreamRes.headers),
        )
        upstreamRes.pipe(res)
      })
      req.pipe(upstream)
      return
    }
    const entry: TrackedStream = {
      sessionId,
      state: holdArmed.has(sessionId) ? 'held' : 'streaming',
      req,
      res,
      upstream: null,
    }
    tracked.add(entry)
    // Long-lived SSE socket: no server-side inactivity timeout.
    if (res.socket !== null) res.socket.setTimeout(0)
    res.on('close', () => onClientGone(entry))
    if (entry.state === 'held') {
      const list = heldStreams.get(sessionId)
      if (list !== undefined) list.push(entry)
      // Accepted, but no response bytes at all — not even a
      // terminal HTTP error: the native EventSource stays in its
      // CONNECTING state until the release forwards the request.
      return
    }
    openUpstream(entry)
  }

  /** Fail-closed per-session control actions (POST JSON only). */
  function dispatchControl(
    action: keyof typeof REALTIME_CONTROL_PATHS,
    sessionId: string,
    res: ServerResponse,
  ): void {
    if (action === 'disconnect') {
      const live = [...tracked].filter(
        (e) => e.sessionId === sessionId && e.state === 'streaming',
      )
      if (live.length !== 1) {
        // Unknown session OR ambiguous (more than one live
        // connection): refuse, change no state.
        sendJson(res, 409, {
          error: 'unknown_or_ambiguous_session',
        })
        return
      }
      // Arm the hold BEFORE the sever: no native retry can slip
      // between the two (this block is synchronous, and the native
      // retry is seconds away anyway).
      holdArmed.add(sessionId)
      heldStreams.set(sessionId, [])
      for (const entry of live) {
        tracked.delete(entry)
        entry.upstream?.destroy()
        entry.res.destroy()
      }
      sendJson(res, 200, { status: 'disconnected' })
      return
    }
    if (action === 'release') {
      if (!holdArmed.has(sessionId)) {
        sendJson(res, 409, { error: 'not_held' })
        return
      }
      const pending = heldStreams.get(sessionId) ?? []
      for (const entry of pending) {
        entry.state = 'streaming'
        openUpstream(entry)
      }
      heldStreams.delete(sessionId)
      holdArmed.delete(sessionId)
      sendJson(res, 200, {
        status: 'released',
        forwarded: pending.length,
      })
      return
    }
    // action === 'reset' — idempotent per-session teardown.
    let destroyed = 0
    for (const entry of [...tracked]) {
      if (entry.sessionId !== sessionId) continue
      tracked.delete(entry)
      destroyed += 1
      entry.upstream?.destroy()
      entry.res.destroy()
    }
    heldStreams.delete(sessionId)
    holdArmed.delete(sessionId)
    sendJson(res, 200, { status: 'reset', destroyed })
  }

  function handleControl(
    req: IncomingMessage,
    res: ServerResponse,
    action: keyof typeof REALTIME_CONTROL_PATHS,
  ): void {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' })
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('error', () => {
      // Swallowed on purpose: no logging of request data.
    })
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_CONTROL_BODY_BYTES) {
        if (!res.headersSent) {
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'body_too_large' }))
        }
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      let sessionId: string
      try {
        const parsed: unknown = JSON.parse(
          Buffer.concat(chunks).toString('utf8'),
        )
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          typeof (parsed as { sessionId?: unknown }).sessionId !==
            'string'
        ) {
          sendJson(res, 400, { error: 'bad_request' })
          return
        }
        sessionId = (parsed as { sessionId: string }).sessionId
      } catch {
        sendJson(res, 400, { error: 'bad_request' })
        return
      }
      if (
        sessionId.length === 0 ||
        sessionId.length > MAX_SESSION_ID_LENGTH
      ) {
        sendJson(res, 400, { error: 'bad_request' })
        return
      }
      dispatchControl(action, sessionId, res)
    })
  }

  return {
    name: 'fg:e2e-realtime-disconnect',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0]
        if (
          req.method === 'GET' &&
          pathname === REALTIME_SSE_PATH
        ) {
          handleSseRequest(req, res)
          return
        }
        if (pathname === REALTIME_CONTROL_PATHS.disconnect) {
          handleControl(req, res, 'disconnect')
          return
        }
        if (pathname === REALTIME_CONTROL_PATHS.release) {
          handleControl(req, res, 'release')
          return
        }
        if (pathname === REALTIME_CONTROL_PATHS.reset) {
          handleControl(req, res, 'reset')
          return
        }
        next()
      })
      // Server teardown: release every tracked connection and hold.
      server.httpServer?.on('close', () => {
        for (const entry of [...tracked]) {
          entry.upstream?.destroy()
          entry.res.destroy()
        }
        tracked.clear()
        heldStreams.clear()
        holdArmed.clear()
      })
    },
  }
}
