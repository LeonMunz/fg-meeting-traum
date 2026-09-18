/**
 * Pure, deterministic logic for the bounded E2E failure-diagnostics
 * artifact (see docs/agent/WORKFLOW.md, "Failure diagnostics artifact").
 *
 * This module must stay free of Playwright imports: it is covered by fast
 * unit tests that run without a browser.
 *
 * Contract highlights:
 * - schemaVersion 1
 * - no request/response bodies, headers, cookies, storage, environment
 *   values, or auth tokens; URLs lose query and fragment
 * - bounded entries per category, bounded string lengths, bounded total
 *   size; truncated data is flagged with `truncated` / `totalTruncated`
 */

export const FAILURE_DIAGNOSTICS_SCHEMA_VERSION = 1

export const FAILURE_DIAGNOSTICS_FILENAME =
  'failure-diagnostics.json'

/** Maximum number of retained entries per diagnostics category. */
export const MAX_ENTRIES_PER_CATEGORY = 20

/** Maximum length of any single string entry. */
export const MAX_ENTRY_STRING = 500

/** Maximum length of the optional ARIA snapshot. */
export const MAX_ARIA_SNAPSHOT = 8_000

/** Hard maximum size of the serialized artifact (bytes): 64 KiB. */
export const MAX_TOTAL_BYTES = 65_536

const UNPARSEABLE_URL = '[unparseable-url]'

export function clampString(
  value: string,
  max: number,
): { value: string; truncated: boolean } {
  if (value.length <= max) {
    return { value, truncated: false }
  }
  return { value: value.slice(0, max), truncated: true }
}

/**
 * Reduce a URL to protocol, host, and path. Query string and fragment are
 * removed because they may carry tokens or other sensitive values.
 * Unparseable input never leaks the raw string.
 */
export function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return UNPARSEABLE_URL
  }
}

export interface RequestFailureEntry {
  method: string
  url: string
  failure: string
}

export interface HttpErrorEntry {
  method: string
  url: string
  status: number
}

export type DiagnosticCategory =
  | 'pageErrors'
  | 'consoleErrors'
  | 'requestFailures'
  | 'httpErrors'

export interface CollectedDiagnostics {
  pageErrors: string[]
  consoleErrors: string[]
  requestFailures: RequestFailureEntry[]
  httpErrors: HttpErrorEntry[]
  truncated: Record<DiagnosticCategory, boolean>
}

export function createCollectedDiagnostics(): CollectedDiagnostics {
  return {
    pageErrors: [],
    consoleErrors: [],
    requestFailures: [],
    httpErrors: [],
    truncated: {
      pageErrors: false,
      consoleErrors: false,
      requestFailures: false,
      httpErrors: false,
    },
  }
}

function pushBoundedString(
  collected: CollectedDiagnostics,
  category: 'pageErrors' | 'consoleErrors',
  raw: string,
): void {
  if (collected[category].length >= MAX_ENTRIES_PER_CATEGORY) {
    collected.truncated[category] = true
    return
  }
  collected[category].push(
    clampString(raw, MAX_ENTRY_STRING).value,
  )
}

export function pushPageError(
  collected: CollectedDiagnostics,
  raw: string,
): void {
  pushBoundedString(collected, 'pageErrors', raw)
}

export function pushConsoleError(
  collected: CollectedDiagnostics,
  raw: string,
): void {
  pushBoundedString(collected, 'consoleErrors', raw)
}

function pushBoundedObject(
  collected: CollectedDiagnostics,
  category: 'requestFailures' | 'httpErrors',
  entry:
    | RequestFailureEntry
    | HttpErrorEntry,
): void {
  if (collected[category].length >= MAX_ENTRIES_PER_CATEGORY) {
    collected.truncated[category] = true
    return
  }
  if (category === 'requestFailures') {
    const failure = entry as RequestFailureEntry
    collected.requestFailures.push({
      method: clampString(failure.method, 16).value,
      url: sanitizeUrl(
        clampString(failure.url, MAX_ENTRY_STRING).value,
      ),
      failure: clampString(
        failure.failure,
        MAX_ENTRY_STRING,
      ).value,
    })
    return
  }
  const http = entry as HttpErrorEntry
  collected.httpErrors.push({
    method: clampString(http.method, 16).value,
    url: sanitizeUrl(
      clampString(http.url, MAX_ENTRY_STRING).value,
    ),
    status: http.status,
  })
}

export function pushRequestFailure(
  collected: CollectedDiagnostics,
  entry: RequestFailureEntry,
): void {
  pushBoundedObject(collected, 'requestFailures', entry)
}

export function pushHttpError(
  collected: CollectedDiagnostics,
  entry: HttpErrorEntry,
): void {
  pushBoundedObject(collected, 'httpErrors', entry)
}

export interface FailureDiagnosticsInput {
  test: {
    title: string
    file: string
    project: string
    retry: number
  }
  observedStatus: string
  expectedStatus: string
  /** Raw page URL at failure time; sanitized inside the builder. */
  lastKnownUrl: string | null
  collected: CollectedDiagnostics
  /** Optional compact ARIA snapshot, or null when unavailable. */
  ariaSnapshot: string | null
  /** Built-in Playwright artifacts whose existence was detected. */
  referencedBuiltInArtifacts: string[]
  /**
   * Byte budget for the serialized artifact. Defaults to
   * MAX_TOTAL_BYTES; smaller values are only used by unit tests.
   */
  maxTotalBytes?: number
}

interface Categorized<T> {
  entries: T[]
  truncated: boolean
}

interface FailureDiagnosticsPayload {
  schemaVersion: number
  test: {
    title: string
    file: string
    project: string
    retry: number
  }
  observedStatus: string
  expectedStatus: string
  lastKnownUrl: string | null
  pageErrors: Categorized<string>
  consoleErrors: Categorized<string>
  requestFailures: Categorized<RequestFailureEntry>
  httpErrors: Categorized<HttpErrorEntry>
  ariaSnapshot: {
    value: string
    truncated: boolean
  } | null
  referencedBuiltInArtifacts: string[]
  totalTruncated: boolean
}

/** Categories dropped from the end first when the byte budget is hit. */
const DROPP_ORDER: DiagnosticCategory[] = [
  'consoleErrors',
  'httpErrors',
  'requestFailures',
  'pageErrors',
]

function dropOneEntry(payload: FailureDiagnosticsPayload): boolean {
  for (const category of DROPP_ORDER) {
    const bucket = payload[category]
    if (bucket.entries.length > 0) {
      bucket.entries.pop()
      bucket.truncated = true
      payload.totalTruncated = true
      return true
    }
  }
  return false
}

function dropAriaTail(payload: FailureDiagnosticsPayload): boolean {
  if (!payload.ariaSnapshot || payload.ariaSnapshot.value.length === 0) {
    return false
  }
  // Drop the last line; fall back to halving for single-line snapshots.
  const newline = payload.ariaSnapshot.value.lastIndexOf('\n')
  const next =
    newline > 0
      ? payload.ariaSnapshot.value.slice(0, newline)
      : payload.ariaSnapshot.value.slice(
          0,
          Math.floor(payload.ariaSnapshot.value.length / 2),
        )
  payload.ariaSnapshot.value = next
  payload.ariaSnapshot.truncated = true
  payload.totalTruncated = true
  return true
}

/**
 * Build the versioned JSON artifact. The result never exceeds
 * MAX_TOTAL_BYTES; content is dropped deterministically (least valuable
 * categories first) and flagged with `totalTruncated`.
 */
export function buildFailureDiagnostics(
  input: FailureDiagnosticsInput,
): string {
  const maxTotalBytes = input.maxTotalBytes ?? MAX_TOTAL_BYTES
  const payload: FailureDiagnosticsPayload = {
    schemaVersion: FAILURE_DIAGNOSTICS_SCHEMA_VERSION,
    test: {
      title: clampString(input.test.title, MAX_ENTRY_STRING).value,
      file: input.test.file,
      project: clampString(input.test.project, 100).value,
      retry: input.test.retry,
    },
    observedStatus: input.observedStatus,
    expectedStatus: input.expectedStatus,
    lastKnownUrl:
      input.lastKnownUrl === null
        ? null
        : sanitizeUrl(input.lastKnownUrl),
    pageErrors: {
      entries: input.collected.pageErrors,
      truncated: input.collected.truncated.pageErrors,
    },
    consoleErrors: {
      entries: input.collected.consoleErrors,
      truncated: input.collected.truncated.consoleErrors,
    },
    requestFailures: {
      entries: input.collected.requestFailures,
      truncated: input.collected.truncated.requestFailures,
    },
    httpErrors: {
      entries: input.collected.httpErrors,
      truncated: input.collected.truncated.httpErrors,
    },
    ariaSnapshot: null,
    referencedBuiltInArtifacts: input
      .referencedBuiltInArtifacts,
    totalTruncated: false,
  }

  if (input.ariaSnapshot !== null && input.ariaSnapshot.length > 0) {
    const clamped = clampString(
      input.ariaSnapshot,
      MAX_ARIA_SNAPSHOT,
    )
    payload.ariaSnapshot = {
      value: clamped.value,
      truncated: clamped.truncated,
    }
  }

  let json = JSON.stringify(payload, null, 2)
  let guard = 0
  while (
    Buffer.byteLength(json, 'utf8') > maxTotalBytes &&
    guard < 500
  ) {
    const droppedEntry = dropOneEntry(payload)
    const droppedAria = droppedEntry ? false : dropAriaTail(payload)
    if (!droppedEntry && !droppedAria) {
      break
    }
    json = JSON.stringify(payload, null, 2)
    guard += 1
  }
  return json
}
