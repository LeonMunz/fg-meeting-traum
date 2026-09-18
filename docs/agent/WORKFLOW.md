# Agent Execution Workflow

This document defines the canonical flow every agent follows for a task and the
canonical evidence contract: the verification statuses agents may claim, the
blocker classifications, and the mandatory completion-report content. It is
execution policy only; it does not duplicate product, domain, or architecture
documentation. For domain invariants read the relevant `docs/domain/*` file; for the
current implementation checkpoint read `docs/CURRENT_STATE.md`.

## Flow

```text
PRECHECK
  -> BASELINE / REPRODUCE
  -> PLAN
  -> EDIT
  -> FAST VERIFY
  -> TARGET VERIFY
  -> FINAL VERIFY
  -> REPORT
```

### PRECHECK

- Read the root `AGENTS.md` and the owning `apps/*` `AGENTS.md` for the affected area.
- Read only the documentation relevant to the change.
- Identify the smallest domain affected.
- Inspect the relevant files and nearby tests before editing.
- If the task conflicts with a documented invariant, stop and report the conflict.

### BASELINE / REPRODUCE

- For a feature: confirm the baseline is green for the touched area (typecheck /
  system check / relevant tests) before editing.
- For a bug: reproduce it deterministically before changing production code. A bug that
  cannot be reproduced is reported as-is, not guessed at.

### PLAN

- State a short, ordered plan for non-trivial changes.
- Prefer the smallest coherent change; do not plan unrelated improvements.

### EDIT

- Make the smallest coherent change that satisfies the task.
- Add or update tests for domain rules introduced or changed.
- Do not perform unrelated refactors and do not add unapproved dependencies.

### FAST VERIFY

- Immediately after structural edits: restore and confirm structural validity.
  - Frontend: `npm run typecheck` must pass.
  - Backend: `uv run python manage.py check` must pass.
- `./scripts/agent-verify.sh quick` is the fast, sandbox-safe combined pass
  (repo hygiene + typecheck + lint + Django system check + migration drift).
  Use it during development instead of ad-hoc command lists.
- Do not proceed to behavioral diagnosis while the tree does not parse/typecheck.

### TARGET VERIFY

- Run the smallest relevant test subset for the changed behavior.
- Frontend: relevant unit tests, plus targeted E2E when a covered flow changed.
- Backend: the relevant app/test subset; migration check for model changes.

### FINAL VERIFY

- Before completing a non-browser slice run `./scripts/agent-verify.sh core`
  (complete frontend + complete backend + repo hygiene).
- `./scripts/agent-verify.sh e2e` only in a browser-capable environment and
  only with explicit consent to the destructive reset:
  `FG_ALLOW_E2E_RESET=1 ./scripts/agent-verify.sh e2e` (the configured
  Playwright startup resets the `fg_e2e` schema).
- Consent to the destructive reset is enforced at the choke point, not only
  in `agent-verify.sh`: the `reset_e2e` management command itself refuses
  (clear error, nonzero exit) unless BOTH `DJANGO_SETTINGS_MODULE=
  config.settings_e2e` and exactly `FG_ALLOW_E2E_RESET=1` are set. The
  refusal happens before any schema drop, migration, or seed, so every
  invocation path is protected: `agent-verify`, `npm run test:e2e`,
  `npx playwright test`, and direct management-command calls. Playwright
  `--list` invocations start no web server and perform no reset, and are
  therefore unaffected. Behavior tests: `apps/api/accounts/test_reset_e2e.py`.
- `./scripts/agent-verify.sh full` is the genuinely complete gate
  (`core` + `e2e`) and the eventual CI/release gate; it cannot pass without
  actually running E2E.
- Plus any targeted E2E spec or app test justified by scope.
- `git diff HEAD --check` must be clean.

### REPORT

- Report changed files, behavior, checks run and their results, and limitations.
- Verification claims follow the Evidence contract below: every gate or checked
  path carries exactly one of the five verification statuses, and the report
  contains the mandatory completion table (exact command, observed result,
  product-path-executed flag, real artifact paths).
- For UI/UX work, name the screens/states that need manual visual verification.
- For a bug, report the resolved FACT, the hypothesis that held, the deciding
  test, and the error classification from the Evidence contract.

## CI gates (GitHub Actions)

The repository carries two CI workflows, both in `.github/workflows/`, and
both run on `pull_request` against `main`, on `push` to `main`, and on manual
`workflow_dispatch`. Each is a single job on a pinned Ubuntu runner that
executes its canonical gate against an isolated, health-checked PostgreSQL 16
service container (CI-only, non-secret credentials). The repository does not
configure branch protection; these gates are advisory checks on the branch
and pull requests.

### Core verification gate (`core.yml`)

`Core verification` runs the canonical non-browser `core` profile (repo
hygiene + complete frontend + complete backend; no Playwright browser). Its
evidence is static and non-browser: typecheck, lint, unit tests, token
contract, production build, Django system check, migration-drift check, and
the Django test suite. A passing core gate proves nothing about browser
behavior; browser E2E evidence comes only from the E2E gate below.

Canonical CI core command (the only gate invocation in the workflow):

```bash
./scripts/agent-verify.sh \
  --summary-json "$RUNNER_TEMP/fg-core/core-summary.json" \
  core
```

Artifacts (access-protected: repository readers only; retention 14 days):

- `core-summary-<run_id>-<run_attempt>` — the `schemaVersion`-1 JSON run
  summary, kept on success AND failure (never on cancellation: a cancelled
  run must not upload a potentially incomplete summary).

Static contract tests for the workflow:
`scripts/tests/core-workflow.test.sh`.

### E2E gate (`e2e.yml`)

`E2E` in `.github/workflows/e2e.yml` executes the canonical E2E gate against
the same kind of isolated, health-checked PostgreSQL 16 service container
(the E2E reset still touches only the `fg_e2e` schema).

Canonical CI E2E command (the only test invocation in the workflow):

```bash
FG_ALLOW_E2E_RESET=1 ./scripts/agent-verify.sh \
  --summary-json "$RUNNER_TEMP/fg-e2e/e2e-summary.json" \
  e2e
```

Artifacts (access-protected: repository readers only; retention 14 days):

- `e2e-summary-<run_id>-<run_attempt>` — the `schemaVersion`-1 JSON run
  summary, kept on success AND failure (never on cancellation: a cancelled
  run must not upload a potentially incomplete summary).
- `e2e-failure-<run_id>-<run_attempt>` — `playwright-report/` +
  `test-results/` with directory structure, on E2E failure only (a cancelled
  run never uploads failure evidence).

An uploaded artifact is never gate success — artifact upload does not itself
prove a passing gate — and the JSON summary is execution evidence only: it
never confers an automatic RUNTIME_VERIFIED status under the Evidence
contract above. A cancelled run is never presented as successful evidence.
Static contract tests for the workflows:
`scripts/tests/core-workflow.test.sh` and `scripts/tests/e2e-workflow.test.sh`.

## Branch workflow

- `main` is the last fully integrated and verified state.
- Every task that changes files starts on its own short-lived slice branch.
- Read-only audits may run on clean `main`.
- A slice is verified locally and targeted, and committed, before it is
  integrated into `main`.
- After integration into `main`, the core and E2E CI gates provide the
  independent remote evidence.
- The slice branch is deleted only after that remote verification passed.
- Branch protection is deliberately disabled in the current solo/early
  phase.
- No mandatory pull requests: the current solo workflow integrates a
  passing slice into `main` by a local fast-forward merge after the commit
  gate.

## Harness contract tests

Four static tests cover the verification harness and the CI workflow
contracts:

```bash
bash scripts/tests/agent-doctor.test.sh
bash scripts/tests/agent-verify.test.sh
bash scripts/tests/core-workflow.test.sh
bash scripts/tests/e2e-workflow.test.sh
```

- `agent-doctor.test.sh` — doctor output formats, exit codes, non-mutation,
  simulated blockers.
- `agent-verify.test.sh` — usage, plan mode, and the `--summary-json`
  contract (deterministic PATH shims; no real profile executes).
- `core-workflow.test.sh` — the security- and contract-critical invariants
  of `.github/workflows/core.yml` (triggers, permissions, pinned
  references, PostgreSQL 16, single canonical `core` invocation).
- `e2e-workflow.test.sh` — the same for `.github/workflows/e2e.yml`, plus:
  `FG_ALLOW_E2E_RESET` appears exactly once, on the canonical gate line.

They test the harness/workflow contract only: they are not executed by any
`agent-verify` profile and are not invoked by the CI workflows. Run them
directly when touching the harness or the workflows.

## Diagnostic labels

Every diagnostic finding is labeled so evidence and speculation stay separate:

- **FACT** — directly observed evidence (a log line, a test result, a diff, a value read).
- **HYPOTHESIS** — a possible explanation, not a conclusion.
- **NEXT TEST** — one test that can falsify the hypothesis or materially distinguish it
  from alternatives.

## Debugging budget

- Maximum 3 failed diagnostic experiments per blocker.
- Maximum 2 materially different root-cause hypotheses per blocker.
- No materially new evidence after the budget is exhausted → **BLOCKED**. Report the
  FACTs, the hypotheses tried, and the tests run.
- Do not escalate an application bug into framework/runtime speculation without direct
  evidence.

## Evidence contract

This section is the single canonical contract for verification claims, blocker
classification, and completion-report content. No other document defines or
redefines these terms; `AGENTS.md` and the documentation map point here.

### Verification statuses

Every gate or product path an agent reports on carries exactly one of these
five statuses. A status is always relative to the specific gate or behavior
that is claimed: executing a command does not make its result RUNTIME_VERIFIED
by itself — the kind of behavior the command actually proves decides.

**IMPLEMENTED**

- Meaning: the code for the change was written (files changed, new code in the
  tree). Nothing more.
- Required evidence: the change itself — the concrete changed file paths (e.g.
  from `git diff --stat` or `git status --short`).
- Does NOT follow: no claim of static correctness, no claim of working
  behavior, no claim that any check passed. IMPLEMENTED alone never justifies
  "verified", "green", or equivalent.

**STATICALLY_VERIFIED**

- Meaning: checks that were actually executed and passed, limited to static
  validation: repository searches and documentation inspection, diff and
  whitespace checks, typecheck, lint, parse/syntax check, Django system check,
  migration-drift check, build.
- Required evidence: the exact executed command(s) and their observed result
  (exit code 0 or PASS output).
- Does NOT follow: no runtime behavior is verified. That a static check was
  actually executed does not make it RUNTIME_VERIFIED — running a command
  proves only the kind of behavior it checks.

**RUNTIME_VERIFIED**

- Meaning: the specific runtime behavior that is claimed was actually executed
  and observed to succeed. The claim's scope is exactly the path that was
  executed: unit/integration tests exercising the changed behavior, browser
  E2E for a UI flow, or a real API/browser call exercising the path.
- Required evidence: the exact executed command, its exit code, and the
  executed behavior path identified (spec file + test names, or endpoint +
  flow).
- Does NOT follow: it may never be derived from static checks. Each runtime
  level proves only the level that was executed:
  - An API rehearsal is RUNTIME_VERIFIED for exactly the API path executed;
    it proves no browser or end-to-end interaction.
  - A doctor preflight is RUNTIME_VERIFIED for exactly the capability tested
    (e.g. the Chromium launch); it proves no product path that later uses
    that capability.
  - A blocked browser can never yield RUNTIME_VERIFIED for a browser path.

**NOT_VERIFIED_ENVIRONMENT_BLOCKED**

- Meaning: the relevant verification could not run because a concrete
  environment blocker was reproduced (browser launch blocked, database
  unreachable, missing runtime, sandbox policy).
- Required evidence: the reproduced, concrete blocker (the
  `agent-doctor.sh --json` capability output or the exact error) AND the exact
  external verification command to run where the blocker does not apply (e.g.
  `FG_ALLOW_E2E_RESET=1 ./scripts/agent-verify.sh e2e` on a browser-capable
  machine).
- Does NOT follow: nothing about the path's behavior. It must never be
  phrased as verified, green, or equivalent.

**NOT_RUN_OUT_OF_SCOPE**

- Meaning: a gate was deliberately not run because it is not required for this
  slice.
- Required evidence: the explicitly named omitted gate(s) and why they are out
  of scope for the slice.
- Does NOT follow: nothing about the gate's current state. "Out of scope" must
  not mask a regression: when the slice's scope changes, the gate becomes
  required and must be run.

### "All green" rule

"All green" (or equivalent: "everything passes", "fully verified") is allowed
only when every gate required for the slice was actually executed and passed.
The report must list which gates those were. If any required gate carries
NOT_VERIFIED_ENVIRONMENT_BLOCKED or NOT_RUN_OUT_OF_SCOPE, the summary states
that explicitly.

### Error classification

Every failed or suspicious verification result is classified before any next
action. A classification states exactly one class, the concrete evidence,
whether the product path was actually reached, and the allowed next action.

**PRODUCT_REGRESSION**

- When: an executed product or test path failed because of product behavior —
  an assertion on documented behavior or a previously green expectation fails
  in the product itself.
- Required evidence: the failing command and its output identifying the
  failing product assertion or step, and the documented invariant or
  expectation it contradicts.
- Product path reached: yes.
- Allowed next action: stop and report the regression. Repair only through a
  dedicated bug task or an explicitly authorized repair in the current task.
  Never weaken the test or change product copy to make it pass.

**STALE_TEST**

- When: the executed path failed because the test or harness no longer matches
  the currently documented, intended product behavior (stale selector, outdated
  fixture), while product behavior remains as documented.
- Required evidence: a FACT that product behavior matches the documented
  invariant, plus the exact stale assertion or selector.
- Product path reached: yes, up to the point where the test diverges from the
  documented behavior.
- Allowed next action: update the stale selector or assertion (product
  behavior unchanged, per the verification boundary), re-run, and report the
  update.

**ENVIRONMENT_OR_HARNESS**

- When: the failure originates in the environment or the test harness (browser
  launch failure, database unreachable, missing dependency, sandbox policy,
  harness crash), not in product behavior.
- Required evidence: the doctor or preflight output identifying the blocked
  capability, plus why the product path is not the cause (e.g. the failure
  occurs before any product page or product assertion).
- Product path reached: no — state explicitly how far the run got.
- Allowed next action: apply the environment budget, then report the gate as
  NOT_VERIFIED_ENVIRONMENT_BLOCKED with the exact external verification
  command. No installation, retry, or escalation loops. An environment blocker
  is a classified gate status, not a debugging-budget **BLOCKED** state.

**SCOPE_DISCOVERY**

- When: verification reveals a gap, regression, or behavior that is not part
  of the task's Definition of Done.
- Required evidence: the concrete observation (command + output) proving the
  finding, plus why it is outside the current slice's scope.
- Product path reached: state yes or no explicitly.
- Allowed next action: report the discovery (with its own error classification
  if a failure occurred) and propose a dedicated task. Do not fix it
  opportunistically unless explicitly authorized.

### Environment budget

After a blocker is detected (by the doctor or any preflight) or on any
environmental failure during verification:

1. One normal attempt at the blocked verification.
2. At most one retry, only after an immediately plausible, non-mutating
   diagnosis (e.g. `agent-doctor.sh --json` output) that names a specific
   cause.
3. Then classify the blocker as ENVIRONMENT_OR_HARNESS, report the gate as
   NOT_VERIFIED_ENVIRONMENT_BLOCKED with the exact external verification
   command, and stop working on that gate.

No dependency installation, no repeated install or launch attempts, no
escalation loops. The doctor never installs, and an agent does not start
installing to unblock a gate.

### Mandatory completion format

A completion report contains one table row per gate or checked path:

| Column | Content |
|---|---|
| Gate or checked path | Profile (e.g. `quick`, `core`, `e2e`) or the concrete product/test path |
| Exact command | The command as executed, including environment variables and flags |
| Status | Exactly one of the five verification statuses |
| Result or exit code | The observed result (PASS/FAIL, pass count, exit code) or `not executed` plus the reason |
| Product path executed | `yes` or `no` |
| Evidence or artifact path | Real, existing artifacts (see artifact rules), or `-` when none exist |

Rules:

- Every gate required for the slice has exactly one row.
- Deliberately omitted gates still get a row, with NOT_RUN_OUT_OF_SCOPE and
  the reason.
- A row with product path executed `no` must not carry RUNTIME_VERIFIED; a
  claimed product runtime verification requires `yes` and the executed
  behavior path named in the command column.
- The summary around the table must never upgrade a row's status (see the
  narrative rule below).

Illustrative example (values must be the observed ones in a real report):

| Gate or checked path | Exact command | Status | Result or exit code | Product path executed | Evidence or artifact path |
|---|---|---|---|---|---|
| quick profile | `./scripts/agent-verify.sh quick` | STATICALLY_VERIFIED | PASS, exit 0 | no | `-` |
| contract search | `rg -n "STATICALLY_VERIFIED" docs/agent/WORKFLOW.md` | STATICALLY_VERIFIED | matches found, exit 0 | no | `-` |
| My Work E2E | `FG_ALLOW_E2E_RESET=1 npm run test:e2e -- my-work` | RUNTIME_VERIFIED | 12/12 passed, exit 0 | yes | `test-results/my-work/trace.zip` |
| e2e profile (browser) | `FG_ALLOW_E2E_RESET=1 ./scripts/agent-verify.sh e2e` | NOT_VERIFIED_ENVIRONMENT_BLOCKED | not executed — `e2e_gate: blocked` (Chromium launch) | no | blocker: doctor output; run externally: `FG_ALLOW_E2E_RESET=1 ./scripts/agent-verify.sh e2e` |

### Artifact rules

- Only artifacts that actually exist may be named; no guessed or free-form
  paths.
- A trace, screenshot, DOM snapshot, or log is attributed to the specific
  failed test (spec file + test/step) it belongs to.
- Generated artifacts (`playwright-report/`, `test-results/`, `dist/`, tsc
  build info, test databases) are never committed unless they are explicitly
  versioned fixtures or baselines.

### Failure diagnostics artifact

Playwright's built-in artifacts (trace `retain-on-failure`, failure
screenshot, HTML report) remain the canonical failure evidence and are
never duplicated or replaced by custom artifacts.

On top of that, an *unexpectedly* failed E2E test (`testInfo.status !==
testInfo.expectedStatus`) may carry a bounded, secret-poor JSON summary:

- Canonical file name: `failure-diagnostics.json`, written exclusively via
  `testInfo.outputPath('failure-diagnostics.json')` and bound to exactly
  that test report via `testInfo.attach('failure-diagnostics', ...)`.
  No free-form or global artifact paths.
- `schemaVersion: 1`. Content: test identity (title, file, project,
  retry), observed vs. expected status, sanitized last page URL, bounded
  `pageErrors`, `consoleErrors` (level `error`), `requestFailures`,
  `httpErrors` (status >= 400), and an optional compact ARIA snapshot
  when the page is still available.
- Excluded by contract: request/response bodies, headers, cookies,
  local/session storage, environment variables, auth tokens. URL query
  and fragment are stripped; unparseable URLs never leak the raw string.
- Bounds: 20 entries per category, 500 characters per string,
  8,000 characters for the ARIA snapshot, 64 KiB total. Truncated
  categories/strings are flagged `truncated`; total-budget drops are
  flagged `totalTruncated`.
- Passing or otherwise expected tests never produce the artifact. No
  custom screenshot, trace, or video recording is performed; the JSON
  may reference built-in artifacts only if their existence was actually
  detected at write time. Diagnostics collection or write errors are
  reported on stderr only and never mask the original test failure.
- Fixture: `e2e/diagnostics/failure-diagnostics.ts` (builds on
  `@playwright/test`, re-exports `test` and `expect`; specs switch import
  source only). Listeners are removed after every test. Currently active
  for `e2e/research-group-scope.spec.ts` only; migrating further specs is
  a per-spec decision.
- Browser-free logic and lifecycle tests: `e2e/diagnostics/unit/`, run
  via `npx playwright test -c playwright.diagnostics.config.ts`.

### Narrative vs. runtime evidence

Runtime evidence outranks the agent's narrative: logs, exit codes, traces, DOM
snapshots, API responses, and git state take precedence over the agent's
summary. If the two diverge, the claim is corrected to match the evidence —
never the other way around. A summary may describe; it may never upgrade a
status (e.g. calling a blocked gate "verified").

### Relationship to `CURRENT_STATE.md`

The checkpoint markers in `docs/CURRENT_STATE.md` (`IMPLEMENTED`, `PARTIAL`,
`NOT IMPLEMENTED`, `KNOWN ISSUE`) are product-state markers about the
repository's implemented state. They are not verification statuses of this
contract and are not reinterpreted by it.

## Session guidance

- Use the **CURRENT** session only for the same root cause or a direct continuation of
  the current work.
- Start a **NEW** session for a new feature/domain/root cause, or after substantial
  debugging has polluted the working context.
- The canonical agent runtime contract and the mandatory per-run runtime/eval
  metadata are defined in `docs/agent/RUNTIME.md`.

## Verification boundary

- Verification may inspect code and execute tests.
- Stale selectors may be updated only when product behavior remains unchanged.
- Verification must not silently become open-ended implementation.
- A discovered application regression requires a dedicated Bug task unless its repair
  was explicitly authorized for the current task.

## Stop rules

- Stop when the requested Definition of Done is met and validated.
- Stop and report **BLOCKED** when the debugging budget is exhausted without materially
  new evidence.
- Do not continue into the next roadmap stage unless explicitly requested.
