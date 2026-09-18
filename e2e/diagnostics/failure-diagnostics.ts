/**
 * Reusable Playwright fixture: bounded, secret-poor failure diagnostics.
 *
 * Builds on the existing @playwright/test setup and re-exports `test` and
 * `expect`, so a spec only has to change its import source:
 *
 *   import { expect, test } from './diagnostics/failure-diagnostics'
 *
 * Behavior:
 * - Listens on the primary test page for `pageerror`, `console` (level
 *   error), `requestfailed`, and `response` (status >= 400).
 * - Listeners are removed after every test (per-test fixture teardown),
 *   so no state leaks between tests.
 * - Only when `testInfo.status !== testInfo.expectedStatus` is a
 *   versioned JSON summary written via
 *   `testInfo.outputPath('failure-diagnostics.json')` and attached to this
 *   exact test report via `testInfo.attach('failure-diagnostics', ...)`.
 * - Passing tests produce no additional artifact.
 * - Playwright's built-in artifacts (trace, failure screenshot, HTML
 *   report) remain canonical; no custom screenshot/trace/video recording
 *   is performed here. The JSON may reference built-in artifacts only if
 *   their existence was actually detected at write time.
 * - Diagnostics collection/writing errors never mask the original test
 *   failure: all diagnostics work is wrapped, and failures are only
 *   reported on stderr.
 *
 * Limits, sanitization, and exclusions are defined in
 * ./diagnostics-core.ts and documented in docs/agent/WORKFLOW.md.
 */

import {
  existsSync,
  statSync,
  writeFileSync,
} from 'node:fs'

import {
  expect,
  test as base,
  type ConsoleMessage,
  type Page,
  type Request,
  type Response,
  type TestInfo,
} from '@playwright/test'

import {
  type CollectedDiagnostics,
  FAILURE_DIAGNOSTICS_FILENAME,
  MAX_ENTRY_STRING,
  buildFailureDiagnostics,
  clampString,
  createCollectedDiagnostics,
  pushConsoleError,
  pushHttpError,
  pushPageError,
  pushRequestFailure,
} from './diagnostics-core'

export { expect }
export type { Page }

/**
 * Built-in artifact file names whose existence may be detected and
 * referenced (never recreated) in the diagnostics JSON.
 */
const BUILT_IN_ARTIFACT_NAMES = ['trace.zip', 'screenshot.png']

/** Attachment name used for testInfo.attach. */
export const FAILURE_DIAGNOSTICS_ATTACHMENT =
  'failure-diagnostics'

/**
 * Test seam for the no-browser fixture lifecycle tests: state of the
 * diagnostics written (or skipped) by the most recent test in this
 * worker. Not part of the diagnostics contract.
 */
export interface DiagnosticsLastRun {
  candidatePath: string
  wrote: boolean
  attached: boolean
  observedStatus: string
  expectedStatus: string
  testErrorMessages: string[]
}

export const __diagnosticsTestHooks: {
  runs: DiagnosticsLastRun[]
  /**
   * The collector of the currently running test, so no-browser tests
   * can feed the real, listener-collected data into
   * writeDiagnosticsIfNeeded.
   */
  currentCollected: CollectedDiagnostics | null
} = { runs: [], currentCollected: null }

/** Test helper: the most recent completed diagnostics run. */
export function lastDiagnosticsRun(): DiagnosticsLastRun {
  const runs = __diagnosticsTestHooks.runs
  if (runs.length === 0) {
    throw new Error('no diagnostics run recorded yet')
  }
  return runs[runs.length - 1]
}

function detectBuiltInArtifacts(
  testInfo: TestInfo,
): string[] {
  const found: string[] = []
  for (const name of BUILT_IN_ARTIFACT_NAMES) {
    const path = testInfo.outputPath(name)
    try {
      if (existsSync(path) && statSync(path).size > 0) {
        found.push(name)
      }
    } catch {
      // Detection is best-effort; never fail the test for it.
    }
  }
  return found
}

async function captureAriaSnapshot(
  page: Page,
): Promise<string | null> {
  try {
    if (page.isClosed()) {
      return null
    }
    const snapshot = await page.ariaSnapshot()
    return typeof snapshot === 'string' && snapshot.length > 0
      ? snapshot
      : null
  } catch {
    return null
  }
}

/**
 * Build, write, and attach the failure-diagnostics artifact when the
 * test result is unexpected (`status !== expectedStatus`).
 *
 * Contract: this function NEVER throws. Any diagnostics problem is
 * reported on stderr only, so the original test failure can never be
 * masked or replaced by a second, dominant diagnostics error.
 */
export async function writeDiagnosticsIfNeeded(args: {
  testInfo: TestInfo
  page: Page
  collected: CollectedDiagnostics
}): Promise<void> {
  // Only unexpected results produce diagnostics.
  if (args.testInfo.status === undefined) {
    return
  }
  if (args.testInfo.status === args.testInfo.expectedStatus) {
    return
  }
  try {
    const json = buildFailureDiagnostics({
      test: {
        title: args.testInfo.title,
        file: args.testInfo.file,
        project: args.testInfo.project?.name ?? 'unknown',
        retry: args.testInfo.retry,
      },
      observedStatus:
        args.testInfo.status ?? 'unknown',
      expectedStatus:
        args.testInfo.expectedStatus,
      lastKnownUrl:
        clampString(
          args.page.url(),
          MAX_ENTRY_STRING,
        ).value || null,
      collected: args.collected,
      ariaSnapshot:
        (await captureAriaSnapshot(
          args.page,
        )) ?? null,
      referencedBuiltInArtifacts:
        detectBuiltInArtifacts(args.testInfo),
    })
    const path = args.testInfo.outputPath(
      FAILURE_DIAGNOSTICS_FILENAME,
    )
    writeFileSync(path, json, 'utf8')
    args.testInfo.attach(
      FAILURE_DIAGNOSTICS_ATTACHMENT,
      {
        path,
        contentType: 'application/json',
      },
    )
  } catch (error) {
    // Never mask the original test failure.
    // eslint-disable-next-line no-console
    console.error(
      '[failure-diagnostics] failed to write diagnostics:',
      error,
    )
  }
}

export const test = base.extend<{
  failureDiagnostics: void,
}>({
  failureDiagnostics: [
    async ({ page }, use, testInfo) => {
      const collected = createCollectedDiagnostics()

      const onPageError = (error: Error) => {
        pushPageError(
          collected,
          String(error?.message ?? error),
        )
      }
      const onConsole = (message: ConsoleMessage) => {
        if (message.type() !== 'error') {
          return
        }
        pushConsoleError(collected, message.text())
      }
      const onRequestFailed = (request: Request) => {
        pushRequestFailure(collected, {
          method: request.method(),
          url: request.url(),
          failure: request.failure()?.errorText ?? '',
        })
      }
      const onResponse = (response: Response) => {
        if (response.status() < 400) {
          return
        }
        pushHttpError(collected, {
          method: response.request().method(),
          url: response.url(),
          status: response.status(),
        })
      }

      page.on('pageerror', onPageError)
      page.on('console', onConsole)
      page.on('requestfailed', onRequestFailed)
      page.on('response', onResponse)

      __diagnosticsTestHooks.currentCollected =
        collected

      await use()

      // Fixture teardown: the test result is final at this point.
      try {
        await writeDiagnosticsIfNeeded({
          testInfo,
          page,
          collected,
        })
      } finally {
        page.off('pageerror', onPageError)
        page.off('console', onConsole)
        page.off('requestfailed', onRequestFailed)
        page.off('response', onResponse)
        __diagnosticsTestHooks.currentCollected =
          null
      }

      __diagnosticsTestHooks.runs.push({
        candidatePath: testInfo.outputPath(
          FAILURE_DIAGNOSTICS_FILENAME,
        ),
        wrote: existsSync(
          testInfo.outputPath(
            FAILURE_DIAGNOSTICS_FILENAME,
          ),
        ),
        attached: testInfo.attachments.some(
          (a) =>
            a.name === FAILURE_DIAGNOSTICS_ATTACHMENT,
        ),
        observedStatus:
          testInfo.status ?? 'unknown',
        expectedStatus: testInfo.expectedStatus,
        testErrorMessages: testInfo.errors.map(
          (e) => e.message ?? '',
        ),
      })
    },
    { auto: true },
  ],
})
