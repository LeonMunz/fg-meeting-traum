/**
 * Fast, deterministic unit tests for the pure failure-diagnostics
 * logic. Runs without a browser (playwright.diagnostics.config.ts).
 */
import {
  expect,
  test,
} from '@playwright/test'

import {
  FAILURE_DIAGNOSTICS_FILENAME,
  FAILURE_DIAGNOSTICS_SCHEMA_VERSION,
  MAX_ARIA_SNAPSHOT,
  MAX_ENTRIES_PER_CATEGORY,
  MAX_ENTRY_STRING,
  MAX_TOTAL_BYTES,
  buildFailureDiagnostics,
  clampString,
  createCollectedDiagnostics,
  pushConsoleError,
  pushHttpError,
  pushPageError,
  pushRequestFailure,
  sanitizeUrl,
} from '../diagnostics-core'

test('canonical constants', () => {
  expect(FAILURE_DIAGNOSTICS_FILENAME).toBe(
    'failure-diagnostics.json',
  )
  expect(FAILURE_DIAGNOSTICS_SCHEMA_VERSION).toBe(1)
  expect(MAX_TOTAL_BYTES).toBe(65_536)
})

test('sanitizeUrl strips query and fragment', () => {
  expect(
    sanitizeUrl(
      'http://127.0.0.1:4173/projects?group=42#section',
    ),
  ).toBe('http://127.0.0.1:4173/projects')

  expect(
    sanitizeUrl(
      'https://example.com/a/b?x=1&y=2#f',
    ),
  ).toBe('https://example.com/a/b')
})

test('sanitizeUrl never leaks unparseable input', () => {
  expect(sanitizeUrl('not a url')).toBe(
    '[unparseable-url]',
  )
  expect(sanitizeUrl('')).toBe('[unparseable-url]')
})

test('clampString keeps short strings untouched', () => {
  expect(clampString('abc', 5)).toEqual({
    value: 'abc',
    truncated: false,
  })
})

test('clampString truncates long strings and flags them', () => {
  const result = clampString('x'.repeat(10), 4)
  expect(result).toEqual({
    value: 'xxxx',
    truncated: true,
  })
})

test('string categories are capped and flagged truncated', () => {
  const collected = createCollectedDiagnostics()
  for (let i = 0; i < 25; i += 1) {
    pushPageError(collected, `error ${i}`)
  }
  expect(collected.pageErrors).toHaveLength(
    MAX_ENTRIES_PER_CATEGORY,
  )
  expect(collected.truncated.pageErrors).toBe(true)
  expect(collected.truncated.consoleErrors).toBe(false)
})

test('pushed strings are clamped to the entry limit', () => {
  const collected = createCollectedDiagnostics()
  pushConsoleError(collected, 'y'.repeat(MAX_ENTRY_STRING + 100))
  expect(collected.consoleErrors[0].length).toBe(
    MAX_ENTRY_STRING,
  )
})

test('request failures sanitize the URL and cap entries', () => {
  const collected = createCollectedDiagnostics()
  for (let i = 0; i < 25; i += 1) {
    pushRequestFailure(collected, {
      method: 'GET',
      url: `http://127.0.0.1:8010/api/${i}?token=abc123`,
      failure: 'net::ERR_FAILED',
    })
  }
  expect(collected.requestFailures).toHaveLength(
    MAX_ENTRIES_PER_CATEGORY,
  )
  expect(collected.truncated.requestFailures).toBe(true)
  const first = collected.requestFailures[0]
  expect(first.url).toBe('http://127.0.0.1:8010/api/0')
  expect(JSON.stringify(collected.requestFailures)).not.toContain(
    'token=abc123',
  )
})

test('http errors keep method, sanitized url and status', () => {
  const collected = createCollectedDiagnostics()
  pushHttpError(collected, {
    method: 'POST',
    url: 'http://127.0.0.1:8010/api/forbidden?csrf=x',
    status: 403,
  })
  expect(collected.httpErrors).toEqual([
    {
      method: 'POST',
      url: 'http://127.0.0.1:8010/api/forbidden',
      status: 403,
    },
  ])
  expect(collected.truncated.httpErrors).toBe(false)
})

test('buildFailureDiagnostics emits the schema-v1 shape', () => {
  const collected = createCollectedDiagnostics()
  pushPageError(collected, 'unhandled page error')
  pushConsoleError(collected, 'console error text')
  pushRequestFailure(collected, {
    method: 'GET',
    url: 'http://127.0.0.1:8010/api/x?token=abc123',
    failure: 'net::ERR_FAILED',
  })
  pushHttpError(collected, {
    method: 'POST',
    url: 'http://127.0.0.1:8010/api/x',
    status: 500,
  })

  const json = buildFailureDiagnostics({
    test: {
      title: 'some failing test',
      file: 'e2e/some.spec.ts',
      project: 'chromium',
      retry: 1,
    },
    observedStatus: 'failed',
    expectedStatus: 'passed',
    lastKnownUrl: 'http://127.0.0.1:4173/projects?group=42#f',
    collected,
    ariaSnapshot: 'heading "Projects"',
    referencedBuiltInArtifacts: ['trace.zip'],
  })

  const parsed = JSON.parse(json)
  expect(parsed.schemaVersion).toBe(1)
  expect(parsed.test).toEqual({
    title: 'some failing test',
    file: 'e2e/some.spec.ts',
    project: 'chromium',
    retry: 1,
  })
  expect(parsed.observedStatus).toBe('failed')
  expect(parsed.expectedStatus).toBe('passed')
  expect(parsed.lastKnownUrl).toBe(
    'http://127.0.0.1:4173/projects',
  )
  expect(parsed.pageErrors).toEqual({
    entries: ['unhandled page error'],
    truncated: false,
  })
  expect(parsed.consoleErrors.entries).toEqual([
    'console error text',
  ])
  expect(parsed.requestFailures.entries).toEqual([
    {
      method: 'GET',
      url: 'http://127.0.0.1:8010/api/x',
      failure: 'net::ERR_FAILED',
    },
  ])
  expect(parsed.httpErrors.entries).toEqual([
    { method: 'POST', url: 'http://127.0.0.1:8010/api/x', status: 500 },
  ])
  expect(parsed.ariaSnapshot).toEqual({
    value: 'heading "Projects"',
    truncated: false,
  })
  expect(parsed.referencedBuiltInArtifacts).toEqual([
    'trace.zip',
  ])
  expect(parsed.totalTruncated).toBe(false)
  const raw = JSON.stringify(parsed)
  expect(raw).not.toContain('group=42')
  expect(raw).not.toContain('#f')
  expect(raw).not.toContain('token=abc123')
})

test('buildFailureDiagnostics clamps the aria snapshot', () => {
  const json = buildFailureDiagnostics({
    test: { title: 't', file: 'f', project: 'p', retry: 0 },
    observedStatus: 'failed',
    expectedStatus: 'passed',
    lastKnownUrl: null,
    collected: createCollectedDiagnostics(),
    ariaSnapshot: 'a\nb\n'.repeat(
      Math.ceil((MAX_ARIA_SNAPSHOT + 5) / 3),
    ),
    referencedBuiltInArtifacts: [],
  })
  const parsed = JSON.parse(json)
  expect(parsed.ariaSnapshot.truncated).toBe(true)
  expect(parsed.ariaSnapshot.value.length).toBeLessThanOrEqual(
    MAX_ARIA_SNAPSHOT,
  )
})

test('buildFailureDiagnostics omits the aria snapshot when unavailable', () => {
  const parsed = JSON.parse(
    buildFailureDiagnostics({
      test: { title: 't', file: 'f', project: 'p', retry: 0 },
      observedStatus: 'failed',
      expectedStatus: 'passed',
      lastKnownUrl: null,
      collected: createCollectedDiagnostics(),
      ariaSnapshot: null,
      referencedBuiltInArtifacts: [],
    }),
  )
  expect(parsed.ariaSnapshot).toBeNull()
})

test('byte budget drops least valuable content first and flags it', () => {
  const collected = createCollectedDiagnostics()
  for (let i = 0; i < MAX_ENTRIES_PER_CATEGORY; i += 1) {
    pushPageError(collected, `page ${i} ` + 'y'.repeat(300))
    pushConsoleError(collected, `console ${i} ` + 'z'.repeat(300))
  }
  const json = buildFailureDiagnostics({
    test: { title: 't', file: 'f', project: 'p', retry: 0 },
    observedStatus: 'failed',
    expectedStatus: 'passed',
    lastKnownUrl: null,
    collected,
    ariaSnapshot: null,
    referencedBuiltInArtifacts: [],
    maxTotalBytes: 4_096,
  })
  const parsed = JSON.parse(json)
  expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(
    4_096,
  )
  expect(parsed.totalTruncated).toBe(true)
  // console errors are dropped before page errors
  expect(parsed.consoleErrors.entries).toHaveLength(0)
  expect(parsed.consoleErrors.truncated).toBe(true)
  expect(parsed.pageErrors.entries.length).toBeGreaterThan(0)
  // schema metadata survives the budget drops
  expect(parsed.schemaVersion).toBe(1)
  expect(parsed.test.title).toBe('t')
})
