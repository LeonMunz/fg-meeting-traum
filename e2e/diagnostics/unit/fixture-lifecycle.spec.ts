/**
 * No-browser fixture lifecycle tests for the failure-diagnostics
 * fixture.
 *
 * The `page` fixture is overridden with a stub that records
 * listeners, so no browser is launched. The failure path is exercised
 * deterministically through the exported writeDiagnosticsIfNeeded
 * function with a fake TestInfo: real, intentionally red tests would
 * make this suite red and Playwright recycles the worker after them,
 * which would break module-level test seams.
 *
 * Runs under playwright.diagnostics.config.ts.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  expect,
  test as base,
  type Page,
  type TestInfo,
} from '@playwright/test'

import {
  FAILURE_DIAGNOSTICS_FILENAME,
  MAX_ENTRIES_PER_CATEGORY,
  MAX_ENTRY_STRING,
  createCollectedDiagnostics,
} from '../diagnostics-core'
import {
  FAILURE_DIAGNOSTICS_ATTACHMENT,
  __diagnosticsTestHooks,
  test as diagnosticsTest,
  writeDiagnosticsIfNeeded,
} from '../failure-diagnostics'

interface StubPage {
  url: () => string
  isClosed: () => boolean
  on: (event: string, listener: (arg: unknown) => void) => void
  off: (event: string, listener: (arg: unknown) => void) => void
  listenerCount: (event: string) => number
  emit: (event: string, arg: unknown) => void
  ariaSnapshot: () => Promise<string>
}

// Set by the masking/degrade tests before they drive the writer:
// makes ariaSnapshot throw during diagnostics collection.
let ariaShouldThrow = false

/**
 * Stub URL deliberately carries a query and a fragment so every
 * diagnostics write proves both are redacted.
 */
const STUB_URL =
  'http://127.0.0.1:4173/projects?group=42#secret'

function createPageStub(): StubPage {
  const listeners = new Map<
    string,
    Set<(arg: unknown) => void>
  >()
  return {
    url: () => STUB_URL,
    isClosed: () => false,
    on: (event, listener) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set())
      }
      listeners.get(event)!.add(listener)
    },
    off: (event, listener) => {
      listeners.get(event)?.delete(listener)
    },
    listenerCount: (event) =>
      listeners.get(event)?.size ?? 0,
    emit: (event, arg) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(arg)
      }
    },
    ariaSnapshot: async () => {
      if (ariaShouldThrow) {
        throw new Error('aria exploded')
      }
      return 'heading "Projects"'
    },
  }
}

/**
 * Minimal fake TestInfo standing in for the real one in the failure
 * path. Real fixture tests (passing case) use the real testInfo.
 */
function createFakeTestInfo(options: {
  status?: string
  expectedStatus?: string
  title?: string
  dir?: string
}): {
  fake: TestInfo
  dir: string
  attachCalls: Array<{
    name: string
    body: { path?: string; contentType?: string }
  }>
} {
  const dir =
    options.dir ??
    mkdtempSync(join(tmpdir(), 'fg-diag-fake-'))
  const attachCalls: Array<{
    name: string
    body: { path?: string; contentType?: string }
  }> = []
  const fake = {
    title: options.title ?? 'fake failing test',
    file: 'e2e/diagnostics/unit/fixture-lifecycle.spec.ts',
    project: { name: 'chromium' },
    retry: 0,
    status: options.status ?? 'failed',
    expectedStatus:
      options.expectedStatus ?? 'passed',
    errors: [],
    attachments: [],
    outputPath: (file: string) => join(dir, file),
    attach: (
      name: string,
      body: { path?: string; contentType?: string },
    ) => {
      attachCalls.push({ name, body })
    },
  } as unknown as TestInfo
  return { fake, dir, attachCalls }
}

const test = diagnosticsTest.extend({
  page: async ({}, use) => {
    await use(createPageStub() as unknown as Page)
  },
})

// ------------------------------------------------------------------
// Real fixture lifecycle: passing test
// ------------------------------------------------------------------

// NOTE: In Playwright, test.afterEach runs BEFORE fixture
// finalization, so the post-teardown state is verified from the
// following test via the module-level run registry (valid because
// green tests keep the worker alive, as proven by the run order).

test('a passing test produces no failure-diagnostics.json', async ({
  page,
}) => {
  expect(page).toBeTruthy()
})

test('verify: passing test wrote nothing, attached nothing, cleared state', () => {
  const runs = __diagnosticsTestHooks.runs
  const last = runs[runs.length - 1]
  expect(
    last,
    'passing test run must be recorded',
  ).toBeTruthy()
  expect(last!.observedStatus).toBe('passed')
  expect(last!.expectedStatus).toBe('passed')
  expect(last!.wrote).toBe(false)
  expect(last!.attached).toBe(false)
  expect(existsSync(last!.candidatePath)).toBe(false)
  expect(last!.candidatePath).toContain(
    FAILURE_DIAGNOSTICS_FILENAME,
  )
})

// ------------------------------------------------------------------
// Real fixture lifecycle: listener cleanup
// ------------------------------------------------------------------

let cleanupStub: StubPage | null = null

test('listeners are removed after the test (no cross-test leaks)', async ({
  page,
}) => {
  cleanupStub = page as unknown as StubPage
  const stub = cleanupStub
  // The fixture attached exactly one listener per event.
  for (const event of [
    'pageerror',
    'console',
    'requestfailed',
    'response',
  ]) {
    expect(stub.listenerCount(event)).toBe(1)
  }
})

test('verify: all diagnostic listeners were removed', () => {
  expect(cleanupStub).not.toBeNull()
  for (const event of [
    'pageerror',
    'console',
    'requestfailed',
    'response',
  ]) {
    // The previous test's stub must be listener-free after its
    // fixture teardown.
    expect(
      cleanupStub!.listenerCount(event),
      event,
    ).toBe(0)
  }
})

// ------------------------------------------------------------------
// Writer: trigger condition
// ------------------------------------------------------------------

test('an unexpected failure writes and attaches valid schema-v1 JSON', async () => {
  const {
    fake,
    dir,
    attachCalls,
  } = createFakeTestInfo({
    status: 'failed',
    expectedStatus: 'passed',
    title: 'the failed test',
  })
  await writeDiagnosticsIfNeeded({
    testInfo: fake,
    page: createPageStub() as unknown as Page,
    collected: createCollectedDiagnostics(),
  })

  const filePath = join(dir, FAILURE_DIAGNOSTICS_FILENAME)
  expect(existsSync(filePath)).toBe(true)
  const raw = readFileSync(filePath, 'utf8')
  const parsed = JSON.parse(raw)
  expect(parsed.schemaVersion).toBe(1)
  expect(parsed.test.title).toBe('the failed test')
  expect(parsed.test.file).toContain(
    'fixture-lifecycle.spec.ts',
  )
  expect(parsed.test.project).toBe('chromium')
  expect(parsed.test.retry).toBe(0)
  expect(parsed.observedStatus).toBe('failed')
  expect(parsed.expectedStatus).toBe('passed')
  // query and fragment are redacted
  expect(parsed.lastKnownUrl).toBe(
    'http://127.0.0.1:4173/projects',
  )
  expect(raw).not.toContain('group=42')
  expect(raw).not.toContain('#secret')
  // optional aria snapshot captured
  expect(parsed.ariaSnapshot).toEqual({
    value: 'heading "Projects"',
    truncated: false,
  })
  // built-in artifacts are only ever referenced
  expect(
    Array.isArray(parsed.referencedBuiltInArtifacts),
  ).toBe(true)
  for (const key of [
    'pageErrors',
    'consoleErrors',
    'requestFailures',
    'httpErrors',
  ]) {
    expect(parsed[key].entries, key).toEqual([])
    expect(parsed[key].truncated, key).toBe(false)
  }
  expect(parsed.totalTruncated).toBe(false)
  // attached to exactly this fake test report
  expect(attachCalls).toEqual([
    {
      name: FAILURE_DIAGNOSTICS_ATTACHMENT,
      body: {
        path: filePath,
        contentType: 'application/json',
      },
    },
  ])
})

test('an expected passing result writes nothing and attaches nothing', async () => {
  const {
    fake,
    dir,
    attachCalls,
  } = createFakeTestInfo({
    status: 'passed',
    expectedStatus: 'passed',
  })
  await writeDiagnosticsIfNeeded({
    testInfo: fake,
    page: createPageStub() as unknown as Page,
    collected: createCollectedDiagnostics(),
  })
  expect(
    existsSync(
      join(dir, FAILURE_DIAGNOSTICS_FILENAME),
    ),
  ).toBe(false)
  expect(attachCalls).toEqual([])
})

test('an expected skipped result writes nothing', async () => {
  const {
    fake,
    dir,
    attachCalls,
  } = createFakeTestInfo({
    status: 'skipped',
    expectedStatus: 'skipped',
  })
  await writeDiagnosticsIfNeeded({
    testInfo: fake,
    page: createPageStub() as unknown as Page,
    collected: createCollectedDiagnostics(),
  })
  expect(
    existsSync(
      join(dir, FAILURE_DIAGNOSTICS_FILENAME),
    ),
  ).toBe(false)
  expect(attachCalls).toEqual([])
})

// ------------------------------------------------------------------
// Writer + real listener collection: bounded and redacted
// ------------------------------------------------------------------

test('the real collection pipeline produces bounded, redacted diagnostics', async ({
  page,
}) => {
  const stub = page as unknown as StubPage
  stub.emit(
    'pageerror',
    new Error('unhandled page error boom'),
  )
  for (let i = 0; i < 25; i += 1) {
    stub.emit(
      'pageerror',
      new Error(
        `error number ${i} ` + 'x'.repeat(2_000),
      ),
    )
  }
  stub.emit('console', {
    type: () => 'error',
    text: () => 'console said: no',
  })
  stub.emit('console', {
    type: () => 'warning',
    text: () => 'warning must be ignored',
  })
  stub.emit('requestfailed', {
    method: () => 'GET',
    url: () =>
      'http://127.0.0.1:8010/api/secret?token=abc123',
    failure: () => ({
      errorText: 'net::ERR_NAME_NOT_RESOLVED',
    }),
  })
  stub.emit('response', {
    status: () => 403,
    url: () =>
      'http://127.0.0.1:8010/api/forbidden',
    request: () => ({ method: () => 'POST' }),
    // Present on real responses, never read by the fixture:
    headers: () => ({
      authorization: 'Bearer super-secret-token',
      cookie: 'session=super-secret-cookie',
    }),
    body: async () => 'password=hunter2',
  })
  stub.emit('response', {
    status: () => 200,
    url: () => 'http://127.0.0.1:8010/api/ok',
    request: () => ({ method: () => 'GET' }),
  })

  const { fake, dir } = createFakeTestInfo({
    status: 'failed',
    expectedStatus: 'passed',
  })
  const collected =
    __diagnosticsTestHooks.currentCollected
  expect(collected, 'live collector').toBeTruthy()
  await writeDiagnosticsIfNeeded({
    testInfo: fake,
    page,
    collected: collected!,
  })

  const raw = readFileSync(
    join(dir, FAILURE_DIAGNOSTICS_FILENAME),
    'utf8',
  )
  const parsed = JSON.parse(raw)
  // categories capped
  expect(parsed.pageErrors.entries).toHaveLength(
    MAX_ENTRIES_PER_CATEGORY,
  )
  for (const entry of parsed.pageErrors.entries) {
    expect(entry.length).toBeLessThanOrEqual(
      MAX_ENTRY_STRING,
    )
  }
  expect(parsed.pageErrors.truncated).toBe(true)
  expect(parsed.pageErrors.entries[0]).toBe(
    'unhandled page error boom',
  )
  // only console level error is collected
  expect(parsed.consoleErrors.entries).toEqual([
    'console said: no',
  ])
  // request failures: sanitized URL, bounded failure text
  expect(parsed.requestFailures.entries).toEqual([
    {
      method: 'GET',
      url: 'http://127.0.0.1:8010/api/secret',
      failure: 'net::ERR_NAME_NOT_RESOLVED',
    },
  ])
  // http errors: status >= 400 only, method + sanitized URL
  expect(parsed.httpErrors.entries).toEqual([
    {
      method: 'POST',
      url: 'http://127.0.0.1:8010/api/forbidden',
      status: 403,
    },
  ])
  // no headers, bodies, cookies, tokens, or ignored levels
  for (const secret of [
    'super-secret-token',
    'super-secret-cookie',
    'hunter2',
    'token=abc123',
    'warning must be ignored',
    '/api/ok',
    'group=42',
    '#secret',
  ]) {
    expect(raw, secret).not.toContain(secret)
  }
})

// ------------------------------------------------------------------
// Writer: error containment (original failure never masked)
// ------------------------------------------------------------------

test('a diagnostics write failure does not mask the original failure', async ({
  page,
}) => {
  const stub = page as unknown as StubPage
  stub.emit(
    'pageerror',
    new Error('original context error'),
  )
  // A directory that does not exist: writeFileSync will fail.
  const { fake } = createFakeTestInfo({
    status: 'failed',
    expectedStatus: 'passed',
    dir: join(
      tmpdir(),
      'fg-diag-missing-parent',
      'fg-diag-does-not-exist',
    ),
  })

  const original = new Error('original boom')
  let diagnosticsRan = false
  try {
    try {
      throw original
    } catch {
      // Diagnostics are attempted after the original failure.
      // If they threw, they would replace the original error.
      await writeDiagnosticsIfNeeded({
        testInfo: fake,
        page,
        collected:
          __diagnosticsTestHooks.currentCollected!,
      })
      diagnosticsRan = true
    }
  } catch (error) {
    // A thrown diagnostics error would land here and mask the
    // original failure.
    expect(
      error,
      'diagnostics must never throw',
    ).toBeNull()
  }
  expect(diagnosticsRan).toBe(true)
  expect(original.message).toBe('original boom')
})

test('an aria snapshot failure degrades to a null snapshot, JSON is still written', async ({
  page,
}) => {
  ariaShouldThrow = true
  try {
    const { fake, dir } = createFakeTestInfo({
      status: 'failed',
      expectedStatus: 'passed',
    })
    await writeDiagnosticsIfNeeded({
      testInfo: fake,
      page,
      collected:
        __diagnosticsTestHooks.currentCollected!,
    })
    const parsed = JSON.parse(
      readFileSync(
        join(dir, FAILURE_DIAGNOSTICS_FILENAME),
        'utf8',
      ),
    )
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.ariaSnapshot).toBeNull()
  } finally {
    ariaShouldThrow = false
  }
})
