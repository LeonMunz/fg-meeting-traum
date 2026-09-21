# FG Workspace — Harness Architecture & Portability

**Status:** CURRENT IMPLEMENTATION specification, with clearly-labeled
PORTABILITY TARGET / RECOMMENDED FUTURE ARCHITECTURE sections.
**Last verified against:** branch `main`, HEAD `8f2deae`
("fix: attribute product codex version from telemetry"), 2026-09-21.
**Canonical detail sources:** this document states the contract, rationale,
and pointers; where a source file or contract JSON is the finer canonical
truth, it is named and this document defers to it.

Every substantial statement in this document carries one of five categories:

- **CURRENT IMPLEMENTATION** — verified against the current code, contract
  tests, or canonical documentation at HEAD.
- **PROJECT-SPECIFIC CONFIGURATION** — real, but FG-Workspace-specific values
  (stack, ports, commands, seeds, doc routing).
- **HOST INTEGRATION** — machine-level, outside the repository.
- **PORTABILITY TARGET / RECOMMENDED FUTURE ARCHITECTURE** — proposed, NOT
  implemented. Never read as current behavior.
- **KNOWN LIMITATION** — a real current constraint, verified.

---

## Table of contents

1. Purpose and scope
2. Executive architecture overview
3. The six Harness Contracts
4. Repository instruction architecture
5. Canonical documentation hierarchy
6. Command surface
7. Environment Doctor architecture
8. Verification architecture
9. Failure classification
10. Work slicing and commit/checkpoint discipline
11. CI architecture
12. E2E and deterministic state architecture
13. Observability goals and non-goals
14. Current product runtime topology
15. Host integration
16. ACP transport and relay architecture
17. Session vs Prompt-Turn lifecycle
18. Run identity and correlation
19. OTel capture pipeline
20. Privacy and security contract
21. Run directory and artifact contract
22. Run Ledger architecture
23. Product Codex version attribution
24. Run context and comparability
25. Evidence gaps
26. Observability command reference
27. Harness contract tests
28. Automatic vs compliance-based enforcement
29. Portability classification
30. Current portability problems
31. Recommended multi-repository target architecture
32. Configuration contract for a future portable harness
33. Minimum viable transfer to Repository 2
34. Desired steady-state onboarding for Repository N
35. New-repository onboarding checklist
36. Conformance test for a new repository
37. Change-impact / maintenance matrix
38. Versioning and upgrade strategy
39. Troubleshooting decision tree
40. Known limitations and deliberate non-goals
41. Eval boundary
42. Glossary
43. Complete file/component map (appendix)

Portability answer index (question → section):
"What is the Harness?" → §1; "components / interaction" → §2, §6, §43;
"generic vs FG-specific" → §29, §30; "host vs repo" → §15, §29;
"automatic vs compliance" → §28; "persisted data / privacy" → §20, §21;
"run start/correlate/finalize" → §17, §18; "verification correlation" → §8, §18;
"CI" → §11; "failure classification" → §9; "fresh agent learns repo" → §4;
"reproduce in Repo 2 today" → §33; "do not duplicate" → §33;
"extract before scaling" → §30, §31; "final multi-repo architecture" → §31;
"prove an onboarded repo works" → §36.

---

## 1. Purpose and scope

### 1.1 Why the harness exists

**CURRENT IMPLEMENTATION.** This repository is developed with coding agents
(Canonical harness: Codex — see `docs/agent/RUNTIME.md`). The agent harness is
the set of repository-owned mechanisms that let a fresh agent, with no
conversation history, safely and verifiably work on this codebase:

1. **Discover the right context** — repository instruction files
   (`AGENTS.md` hierarchy) and a documentation map that route an agent to the
   smallest relevant document set instead of everything.
2. **Know what the environment can do** — a read-only environment doctor
   that reports capability status without installing or mutating anything.
3. **Verify at the right width** — a single verification interface with
   profiles ordered from fast/static to complete/browser, a targeted-
   before-broad ladder, and a machine-readable run summary.
4. **Claim evidence honestly** — a canonical Evidence contract (five
   verification statuses, four error classes, one environment budget, a
   mandatory completion-report table) that separates what was actually
   executed from what was only written.
5. **Observe runs locally (optional)** — a local, loopback-only,
   privacy-bounded trace-capture and Run Ledger facility for the product
   agent, plus a transparent ACP relay that gives every prompt turn its own
   normalized run without any manual lifecycle.

The harness solves concrete problems: agents over-claiming verification
("green" from a typecheck), agents running the wrong-width check (full E2E
for a doc edit, or none at all), environment blockers being chased as bugs,
destructive state resets run by accident, and post-hoc "why did this agent
run do that" questions that have no captured evidence.

### 1.2 What counts as the "agent harness"

**CURRENT IMPLEMENTATION.** The harness is exactly this set of repository-
owned artifacts (full map in §43):

- Repository instruction files: `AGENTS.md` (root), `apps/api/AGENTS.md`,
  `apps/web/AGENTS.md`.
- Canonical execution policy and evidence contract: `docs/agent/WORKFLOW.md`.
- Canonical runtime contract: `docs/agent/RUNTIME.md`.
- Verification interface: `scripts/agent-verify.sh` (profiles `quick`,
  `frontend`, `backend`, `core`, `e2e`, `full`; `plan`; `--summary-json`).
- Environment doctor: `scripts/agent-doctor.sh`.
- Observability control surface: `scripts/agent-observability` and
  `scripts/observability/*` (relay, ledger, manifest, liveness, run context,
  product-runtime registration, collector config template, version pins).
- Automatic product-session lifecycle: `scripts/agent-product-launch`
  (install/status/uninstall/launch) + the ACP lifecycle relay.
- Harness contract tests: `scripts/tests/*.test.sh` + fixtures.
- CI gates and their static contract tests: `.github/workflows/core.yml`,
  `.github/workflows/e2e.yml`, `scripts/tests/core-workflow.test.sh`,
  `scripts/tests/e2e-workflow.test.sh`.
- E2E deterministic-state infrastructure: `reset_e2e` / `seed_dev` /
  `seed_e2e_scope` management commands, `playwright.config.ts`, `e2e/`
  specs, `apps/api/config/settings_e2e.py`.
- Observability contracts: `docs/agent/trace-contract.json`,
  `docs/agent/ledger-contract.json`, `docs/agent/OBSERVABILITY.md`.

### 1.3 What is deliberately outside the harness

- **Product code** (`apps/web`, `apps/api` source) — the harness verifies
  it but never grants access through it; authorization is product/server
  concern.
- **Eval infrastructure** (`evals/`) — a separate system for historical-
  state evaluation runs; see §41. It is not required for normal product
  work and shares only the runtime-metadata contract (`docs/agent/RUNTIME.md`).
- **User-level Codex configuration and authentication** — the repository
  never edits `$CODEX_HOME/config.toml` or any auth file; enabling telemetry
  is an explicit manual user action (§19, §20).
- **Host-installed binaries and the Lucid client** — §15.
- **Branch protection / PR policy** — deliberately not configured (the CI
  gates are advisory checks; see §11).

### 1.4 Principles

**CURRENT IMPLEMENTATION** (all six codified in `docs/agent/WORKFLOW.md` and
the `AGENTS.md` files):

1. **Deterministic commands** — one canonical entrypoint per job
   (`agent-verify`, `agent-doctor`, `agent-verify plan`); phases run
   sequentially with no retries, no parallelism, no implicit installs;
   identical inputs give identical phase lists.
2. **Repository-grounded context** — the repository root is the anchor
   (scripts resolve it from their own path, independent of caller CWD); all
   persistent harness state lives under the git-ignored `.artifacts/`
   directory inside the repo.
3. **Evidence over narrative** — logs, exit codes, traces, and git state
   outrank the agent's summary; a summary may describe but never upgrade a
   verification status.
4. **Targeted-before-broad verification** — smallest relevant subset during
   development; complete profile before finishing a slice; browser E2E only
   when justified and consented.
5. **Failure classification before repair** — every failed or suspicious
   result gets exactly one class (PRODUCT_REGRESSION / STALE_TEST /
   ENVIRONMENT_OR_HARNESS / SCOPE_DISCOVERY) with evidence, before any next
   action (§9).
6. **Short independently verifiable slices** — one dominant product outcome
   per slice/commit, verified before integration.
7. **Clean commit/checkpoint boundaries** — `main` is the last fully
   integrated and verified state; slices are committed and verified before
   integration; generated artifacts are never committed.

### 1.5 Terminology (short definitions; full glossary in §42)

- **Harness** — the repository-owned mechanisms in §1.2.
- **Run** — one observability capture: one started collector lifecycle with
  its own run directory; in the automatic product path, one run per prompt
  turn.
- **Turn** — one ACP `session/prompt` request plus its matching response
  (the foreground agent work unit).
- **ACP session** — the long-lived conversation identity (native Codex
  thread id); a grouping dimension, not a run boundary.
- **Canonical source** — the single owner of a given kind of truth (§5).
- **Final gate** — the complete verification required for a slice to be
  considered done (`core` for non-browser, `full` incl. E2E where browser
  evidence is required).
- **Product runtime** — the host-managed Codex the product agent actually
  runs in (its `CODEX_HOME`); distinct from the **controller runtime**
  (the standalone Codex of the developer shell).

---

## 2. Executive architecture overview

**CURRENT IMPLEMENTATION.** Two orthogonal systems share one repository:

**(A) The verification/instruction system** — always active, compliance-
and script-enforced:

```text
Developer / coding agent
        |
        v
AGENTS.md hierarchy + docs/README.md map
   (root AGENTS.md auto-discovered; scoped AGENTS.md read per PRECHECK;
    docs read on demand, smallest relevant set)
        |
        v
Task PRECHECK -> BASELINE/REPRODUCE -> PLAN -> EDIT
        |
        v
Capability discovery:  ./scripts/agent-doctor.sh [--json]
   (read-only; capability matrix; environment budget on blocker)
        |
        v
Implementation + targeted verification (app tests / single spec)
        |
        v
Verification surface:  ./scripts/agent-verify.sh <profile>
   quick -> frontend|backend -> core ; e2e/full need browser + consent
   plan <profile> = dry run ; --summary-json = machine-readable evidence
        |
        v
REPORT: Evidence contract statuses + mandatory completion table
        |
        v
CI gates (advisory): core.yml -> agent-verify core
                     e2e.yml  -> FG_ALLOW_E2E_RESET=1 agent-verify e2e
```

**(B) The observability system** — optional, automatic when installed,
fail-open when not:

```text
Lucid / PyCharm (ACP client)
        |
        v
Host trampoline  ~/.local/bin/lucid-codex-acp        [HOST INTEGRATION]
        |
        v
scripts/agent-product-launch launch (recursion guard, opt-out, delegate)
        |
        v
scripts/observability/acp-lifecycle-relay.py
   (byte-transparent NDJSON stdio relay; observes session/prompt turns;
    holds a capturable prompt line until the collector is confirmed
    accepting — readiness ordering)
        |
        v
Original launcher (delegate) -> codex-acp -> policy guard -> Codex
        |
        |  per prompt turn:  request -> start --json (held until the
        |                   collector is accepting) -> prompt forwarded
        |                   response(stopReason) -> stop --stop-status graceful
        v
otelcol-contrib 0.161.0 (loopback-only OTLP/HTTP JSON, 127.0.0.1:4318)
   sanitizing transform -> file exporters
        |
        v
.artifacts/agent-runs/<run-id>/   (manifest, raw/*.jsonl, run-context.json,
                                   verify-<profile>.json, agent-doctor-start.json,
                                   annotations.json, run-ledger.json)
        |
        v
Run Ledger (schema v2) + verification summary correlation (agentRunId /
session mapping) + bounded relay event log (.artifacts/agent-observability/)
```

The two systems intersect at exactly two places, both deliberate:

1. `agent-verify --summary-json` can auto-correlate its run summary to the
   active product run (session mapping first, single live capture second,
   explicit `FG_AGENT_RUN_ID` always wins) — §8.5, §18.
2. `agent-observability start` snapshots `agent-doctor.sh --json` read-only
   into the run directory as environment evidence — §8, §22.

Neither system requires the other: verification runs without observability
(observability is a doctor *optional* capability), and observability runs
without any verification (a run may carry no verification evidence, recorded
as an evidence gap).

---

## 3. The six Harness Contracts

The harness is organized as six contracts. Each has a machine-enforced part
(scripts, tests, CI) and a prose/compliance part (rules an agent must follow
because instructions say so). §28 classifies every rule precisely.

### 3.1 Repository Contract

- **Purpose** — where truth lives, what may be edited, and how changes are
  integrated, so that parallel work and agent sessions never fight over
  sources of truth.
- **Current implementation** — root `AGENTS.md` (scope: repository map, core
  domain rules, working method, scope control, git discipline); scoped
  `apps/api/AGENTS.md` and `apps/web/AGENTS.md` (stack, verification ladder,
  Playwright/Playwright-consent rules); `docs/README.md` (documentation
  ownership map); `docs/CURRENT_STATE.md` (the single live implementation
  checkpoint). Git discipline: `main` = last fully integrated verified
  state; slices on short-lived branches; no commit/push/rebase/rewrite
  unless explicitly asked; no lockfile changes unless dependencies changed.
- **Canonical sources** — `AGENTS.md`, `apps/*/AGENTS.md`,
  `docs/README.md` ("Source-of-truth ownership"), `docs/CURRENT_STATE.md`.
- **Machine-enforced** — `git diff HEAD --check` as the first `agent-verify`
  phase (whitespace hygiene); CI runs the canonical gates; `.artifacts/`
  git-ignored so runtime state never commits.
- **Compliance-only** — reading the right docs before coding, smallest-
  domain selection, stop-on-conflict, one outcome per slice, no unrelated
  refactors, scope control (no new dependencies/frameworks without
  approval).
- **Portability** — REPO KNOWLEDGE (content) + CORE (the shape: a root
  instruction file, scoped supplements, a doc map, a live checkpoint).

### 3.2 Environment Contract

- **Purpose** — make capability assumptions explicit and testable instead of
  letting failures surface mid-verification.
- **Current implementation** — `scripts/agent-doctor.sh` capability matrix
  (§7): runtimes (Node ≥ 24, npm, uv, Python ≥ 3.12 preferring
  `apps/api/.venv`), dependency presence, PostgreSQL reachability
  (connect + `SELECT 1` only), Playwright + Chromium preflight (bounded
  headless launch, then closed), network probe, and the optional
  `agent_observability` collector capability.
- **Canonical sources** — `scripts/agent-doctor.sh`,
  `docs/living-lab.md` ("Environment doctor"), `scripts/agent-verify.sh`
  `plan` output (per-profile prerequisites).
- **Machine-enforced** — doctor status values and exit codes (contract-
  tested); the environment budget after a blocker (one attempt, at most one
  retry after a non-mutating diagnosis, then classify and stop — prose
  policy in `docs/agent/WORKFLOW.md`).
- **Compliance-only** — the budget itself; never installing to unblock a
  gate; reporting `NOT_VERIFIED_ENVIRONMENT_BLOCKED` with the exact
  external command.
- **Portability** — the capability *model* is CORE; the individual checks
  are CONFIG/REPO KNOWLEDGE (they assume Node/uv/Django/Playwright/Postgres
  — §30).

### 3.3 Command Contract

- **Purpose** — one stable, documented entrypoint per job so agents and CI
  invoke identical behavior.
- **Current implementation** — full inventory in §6. The canonical surface:
  `agent-doctor.sh`, `agent-verify.sh` (profiles + `plan` +
  `--summary-json`), `agent-observability` (12 subcommands),
  `agent-product-launch` (install/status/uninstall/launch), targeted
  commands from the scoped `AGENTS.md` ladders (`npm run typecheck`,
  `uv run python manage.py test <app>`, etc.), and the human setup/dev
  commands in the root `README.md`.
- **Canonical sources** — the scripts themselves (usage/help output is the
  contract), `docs/agent/OBSERVABILITY.md` (observability surface).
- **Machine-enforced** — usage/exit-code contracts are behaviorally tested
  (`scripts/tests/agent-doctor.test.sh`, `agent-verify.test.sh`,
  `agent-observability.test.sh`, `agent-product-launch.test.sh`); CI
  workflow contract tests pin that CI calls exactly the canonical commands.
- **Compliance-only** — choosing the right width (targeted before broad).
- **Portability** — entrypoint *shape* is CORE; the commands themselves are
  CONFIG.

### 3.4 State Contract

- **Purpose** — deterministic, reproducible state for tests and E2E; no
  cross-run contamination.
- **Current implementation** —
  - Backend tests: Django test runner creates and drops its own test
    database (mutation class `MUTATE_TESTDB`; the development database is
    never touched).
  - E2E: the Playwright `webServer` startup runs `reset_e2e`
    (`DROP SCHEMA fg_e2e CASCADE` + migrations + `seed_dev` +
    `seed_e2e_scope`) inside the isolated `fg_e2e` schema only
  (`apps/api/config/settings_e2e.py`, `search_path=fg_e2e`), gated by the
    double
    consent in `reset_e2e` itself (`DJANGO_SETTINGS_MODULE=
    config.settings_e2e` AND exactly `FG_ALLOW_E2E_RESET=1`) — enforced
    before any schema drop, on every invocation path (§12).
  - Fixtures: deterministic seeds (users `alex`/`chris`/`maria`/`laura`,
    `SEED_PASSWORD` env, default `DevPass1!`), serial Playwright execution
    (`workers: 1`, `fullyParallel: false`).
  - Harness runtime state: all under git-ignored `.artifacts/` (runs,
    collector, session mappings, relay log) with retention/rotation
    (§21).
- **Canonical sources** — `playwright.config.ts`,
  `apps/api/accounts/management/commands/{reset_e2e,seed_dev,seed_e2e_scope}.py`,
  `apps/api/config/settings_e2e.py`, `docs/living-lab.md` (Seed data /
  Reset), `apps/api/AGENTS.md` (consent contract).
- **Machine-enforced** — the consent gate in `reset_e2e` (behavior tests
  `accounts/test_reset_e2e.py`), `agent-verify` e2e refusal without consent
  (before any server starts or DB touch).
- **Compliance-only** — treating generated artifacts as non-committable;
  not re-running E2E against stale state.
- **Portability** — the *pattern* (isolated E2E schema + deterministic seed
  + destructive-reset consent at the choke point) is CORE; the Django/
  Playwright/seed specifics are REPO KNOWLEDGE/CONFIG.

### 3.5 Evidence Contract

- **Purpose** — one vocabulary for what was actually proven, so reports are
  comparable and non-upgradable.
- **Current implementation** — `docs/agent/WORKFLOW.md` ("Evidence
  contract") is the single canonical owner: five verification statuses
  (IMPLEMENTED, STATICALLY_VERIFIED, RUNTIME_VERIFIED,
  NOT_VERIFIED_ENVIRONMENT_BLOCKED, NOT_RUN_OUT_OF_SCOPE), the "all green"
  rule, four error classifications (§9), the environment budget, the
  mandatory completion table, artifact rules, and the narrative-vs-runtime
  rule.
- **Canonical sources** — `docs/agent/WORKFLOW.md` only (no other document
  redefines these terms); `agent-verify --summary-json` output is
  *execution evidence only* and never upgrades a status.
- **Machine-enforced** — nothing can enforce a *claim*; the machine parts
  are the inputs: summary JSON with real exit codes, doctor JSON, Playwright
  failure artifacts (trace/screenshot/`failure-diagnostics.json`), and the
  ledger's refusal to invent classifications.
- **Compliance-only** — the statuses themselves, the table, the
  classifications, the budgets.
- **Portability** — CORE (the whole model is stack-independent).

### 3.6 Context Contract

- **Purpose** — an agent loads the smallest sufficient context, never the
  whole repository's knowledge.
- **Current implementation** —
  - *Always loaded*: root `AGENTS.md` (auto-discovered by the agent runtime
    at the repository root).
  - *Instruction-required, on-demand*: scoped `AGENTS.md` for the affected
    app (read during PRECHECK); `docs/README.md` map; the smallest relevant
    docs per the routing table (product/architecture/domain/living-lab/
    agent docs).
  - *Explicitly discovered*: capability via `agent-doctor.sh`; current
    state via `docs/CURRENT_STATE.md`; relevant Stitch screen for UI tasks
    (only the specific screen, never the whole export directory).
  - *Deliberately excluded*: `node_modules/`, `dist/`, `.git/`, generated
    files, unrelated Stitch exports, unrelated feature directories.
- **Canonical sources** — root `AGENTS.md` ("Documentation usage", "Context
  discipline"), `docs/README.md`.
- **Machine-enforced** — nothing; this is the most compliance-dependent
  contract (residual risk noted in §28).
- **Compliance-only** — all of it; the harness only *provides* the routing.
- **Portability** — the *shape* (root + scoped + map + checkpoint +
  on-demand rule) is CORE; the content is REPO KNOWLEDGE.

---

## 4. Repository instruction architecture

### 4.1 Files and discovery

**CURRENT IMPLEMENTATION.**

| File | Scope | Loaded |
|---|---|---|
| `AGENTS.md` (root) | repository-wide: purpose, stable technical direction, repo map, doc routing, context discipline, core domain rules, working method, verification validation, scope control, frontend/backend rules, git, stop condition | automatically discovered by agent runtimes that support `AGENTS.md` at the repo root |
| `apps/api/AGENTS.md` | backend stack, durable backend rules, E2E consent contract, backend verification ladder, debugging discipline | read on demand — required by the root PRECHECK step when the backend is touched |
| `apps/web/AGENTS.md` | frontend stack, durable frontend rules, frontend verification ladder, Playwright rules, UI rules, debugging discipline | read on demand — required by the root PRECHECK step when the frontend is touched |

Discovery behavior:

- **Automatically injected/discovered**: the root `AGENTS.md`. This is the
  only instruction file an agent can be assumed to have seen with zero
  cooperation.
- **Required by instructions, dependent on agent compliance**: the scoped
  files and every document. The root `AGENTS.md` PRECHECK step *orders* the
  agent to read the owning `apps/*` `AGENTS.md` and only relevant docs —
  but nothing in the tree enforces that read. §28 classifies this.

### 4.2 Source-of-truth hierarchy

**CURRENT IMPLEMENTATION.** The hierarchy, as fixed by `docs/README.md`
("Source-of-truth ownership") and the task-level source-of-truth rule:

1. **Current code** (Django models + migrations = implemented persistence;
   DRF serializers/endpoints = implemented API contract; TypeScript
   API/domain types = frontend contract representation) — authoritative for
   "what exists".
2. **Behavioral/contract tests** — authoritative for "what must hold".
3. **Canonical repository documentation** — one owner per truth class:
   product meaning (`docs/product.md`), architecture (`docs/architecture.md`),
   domain invariants (`docs/domain/*`), current checkpoint
   (`docs/CURRENT_STATE.md`), living-lab/testing (`docs/living-lab.md`),
   agent flow/evidence (`docs/agent/WORKFLOW.md`), runtime contract
   (`docs/agent/RUNTIME.md`), observability (`docs/agent/OBSERVABILITY.md`).
4. **Git/runtime evidence** — current branch/HEAD/status, doctor output,
   real command results.
5. **Historical commit evidence** — rationale only, when otherwise
   unavailable.

Conversation history is not authoritative. If implementation and
documentation diverge, the rule is: report the mismatch, do not silently
choose one.

### 4.3 Relationship to other document classes

- `CURRENT_STATE.md` — the *only* live checkpoint; historical checkpoints
  belong in git history; no parallel status files or aliases are allowed.
  Its markers (IMPLEMENTED/PARTIAL/NOT IMPLEMENTED/KNOWN ISSUE) are
  product-state markers, not Evidence-contract verification statuses.
- `docs/domain/*` — durable invariants the harness references but never
  re-states (the root `AGENTS.md` "Core domain rules" is the short binding
  extract; the domain docs are the full semantics).
- `docs/agent/WORKFLOW.md` — execution policy only; it points to the domain
  docs rather than duplicating them.
- `docs/agent/plans/*` — per-task planning documents; task-local, not
  canonical.

### 4.4 What belongs in AGENTS.md — and what must not

- **Belongs**: binding rules (safety, scope, git, domain invariants
  extract), routing to canonical docs, canonical commands, verification
  profiles, stop conditions.
- **Must not**: product/domain semantics (→ `docs/domain/*`), implemented-
  state claims (→ `CURRENT_STATE.md`), step-by-step debugging diaries,
  duplicate definitions of Evidence-contract terms, machine-specific paths,
  volatile counts (test counts, file lists that drift).

### 4.5 Fresh-agent adoption model

**CURRENT IMPLEMENTATION** (derived from the files and contract tests, not
historical prose). A fresh agent with no history succeeds when it follows
the encoded PRECHECK:

1. The runtime injects root `AGENTS.md` (the only guaranteed input).
2. Root `AGENTS.md` names the exact next reads: the owning `apps/*`
   `AGENTS.md`, the specific `docs/*` file for the task area, and
   `docs/CURRENT_STATE.md` for the implementation checkpoint.
3. The scoped `AGENTS.md` file names the exact verification commands and
   their order (the ladder), and the consent rule for E2E.
4. `docs/agent/WORKFLOW.md` supplies the flow and the evidence vocabulary.

The known compliance dependencies (no machine enforcement): step 2's
reads, step 3's ladder ordering, and all Evidence-contract reporting. The
conformance test in §36 is the acceptance check that this model works for
a specific repository.

---

## 5. Canonical documentation hierarchy

**CURRENT IMPLEMENTATION.**

| Class | Files | Owns | Changes when | Staleness risk |
|---|---|---|---|---|
| Instructions | `AGENTS.md`, `apps/*/AGENTS.md` | binding rules, routing, commands | rules/commands change | low if kept short; high if it starts carrying state claims |
| Doc map | `docs/README.md` | routing + source-of-truth ownership | doc set changes | medium (routing breaks silently) |
| Checkpoint | `docs/CURRENT_STATE.md` | what is implemented right now | every product slice | **highest** — must move with code |
| Product | `docs/product.md` | vision, scope, milestones | product decisions | low |
| Architecture | `docs/architecture.md` | stack, boundaries, sequencing | architecture decisions | low |
| Domain | `docs/domain/*.md` (foundation, meetings, authorization, activity, home, authentication-sessions, account-invitations, account-registration) | invariants and semantics | domain decisions | low (durable by design) |
| Design | `docs/design/tokens.md`, `docs/concepts/`, `docs/design/` | design tokens / concepts | design decisions | low |
| Living Lab | `docs/living-lab.md` | testing strategy, seeds, reset, environments, doctor status values, privacy | tooling/test changes | medium |
| Agent | `docs/agent/WORKFLOW.md`, `RUNTIME.md`, `OBSERVABILITY.md`, `trace-contract.json`, `ledger-contract.json`, `plans/` | execution contract, runtime contract, observability contract + schemas | harness changes | medium (must track script behavior) |
| Visual refs | `docs/stitch_examples/` | UI appearance only (explicitly not runtime/domain/architecture) | design iterations | n/a (reference-only) |
| Human runbook | `README.md` (root) | local setup/dev (German-language runbook: Docker Postgres, npm ci, uv sync, dev servers) | toolchain changes | low |

Duplication is avoided by single-owner rules: each truth class has exactly
one canonical owner (`docs/README.md` "Source-of-truth ownership"); other
docs reference, never re-define (e.g. no document besides
`docs/agent/WORKFLOW.md` defines verification statuses). Persistent
domain/architecture invariants belong in `docs/domain/*` /
`docs/architecture.md`; per-slice state belongs only in
`CURRENT_STATE.md`; harness behavior belongs in `docs/agent/*` + the
scripts themselves.

Update discipline: a durable change flows Observation → Product decision →
Canonical documentation → Backend → API → Frontend → Tests (docs before
implementation for durable changes); `CURRENT_STATE.md` updates accompany
the code change in the same slice; harness doc updates accompany harness
script changes (pinned by the contract tests where behavior is asserted).

---

## 6. Command surface

**CURRENT IMPLEMENTATION.** Only commands that exist at HEAD are listed.
There is **no** `bootstrap` script, and no `test-changed`, `check-fast`,
or `check-all` commands — those conceptual names do not exist in this
repository; the real equivalents are the table below. All `./scripts/*`
commands work from any caller CWD (they resolve the repo root from their
own path).

### 6.1 Canonical harness commands

| Command | Purpose | Mutating? | Key args / profiles | Exit codes | Prerequisites | CI relation | Classification |
|---|---|---|---|---|---|---|---|
| `./scripts/agent-doctor.sh` | read-only environment capability matrix | no (connect + `SELECT 1` only) | `--json`, `--help` | 0 all available; 1 completed with ≥1 blocked/unavailable/unknown; 2 usage; 3 internal failure | git worktree | none (run directly; not in any verify profile) | CORE shape + CONFIG checks |
| `./scripts/agent-verify.sh quick` | fast static pass (sandbox-safe) | no | — | 0 pass; failing phase's own exit code; 2 usage | Node ≥ 24 + npm deps; uv env in sync; no DB needed | none (CI core includes it transitively) | CORE shape + CONFIG commands |
| `./scripts/agent-verify.sh frontend` | complete non-browser frontend | build output only (`dist/`) | — | as above | Node ≥ 24 + npm deps | part of `core` in CI | CONFIG |
| `./scripts/agent-verify.sh backend` | complete backend (uv env) | Django test DB only (created + dropped) | — | as above | uv env; PostgreSQL reachable | part of `core` in CI | CONFIG |
| `./scripts/agent-verify.sh core` | all complete non-browser validation | as frontend+backend | — | as above | Node + uv + PostgreSQL | **CI core gate** (`.github/workflows/core.yml`) | CONFIG |
| `./scripts/agent-verify.sh e2e [playwright args]` | browser E2E only | **DESTRUCTIVE**: resets `fg_e2e` schema; writes `playwright-report/`, `test-results/` | args pass through (`-- spec`, `-g`, `--headed`…) | 2 refusal without consent; failing phase's code otherwise | browser-capable env; PostgreSQL; **`FG_ALLOW_E2E_RESET=1`** | **CI E2E gate** (`.github/workflows/e2e.yml`) | CONFIG |
| `./scripts/agent-verify.sh full` | `core` + `e2e`; never silently skips E2E | as core+e2e | — | as above | all of the above | intended release gate (not itself a CI job) | CONFIG |
| `./scripts/agent-verify.sh plan <profile>` | non-mutating inspection of a profile: phases, exact commands, mutation class, prerequisites | no | `<profile>` | 0; 2 usage (also rejects `--summary-json`) | none | n/a | CORE |
| `./scripts/agent-verify.sh --summary-json <path> <profile>` | run profile + write exactly one versioned JSON summary (schemaVersion 1) at the explicit existing path | summary file + phase artifacts | path must exist (dir pre-existing, writable) | as the profile; 2 for invalid target | target directory exists | CI uses it (summaries are artifacts) | CORE |
| `./scripts/agent-observability status [--json]` | read-only control-surface state (collector, endpoint, product home, otel config, session) | no | `--json` | 0 | python3 | none | CORE |
| `./scripts/agent-observability start [--json]` | start local collector for one product run (`run-<UTC ts>`); doctor snapshot + start Git evidence; idempotent | run dir, PID | `--json` (single-write JSON: `started`/`already_running`, run_id, pid, endpoint) | 1 generic; 3 collector missing; 4 port conflict | collector installed (or on PATH / `FG_OTELCOL`) | none | CORE |
| `./scripts/agent-observability stop [--stop-status graceful\|interrupted]` | graceful drain, manifest finalize, end Git evidence, ledger normalization; cleans PID; never deletes trace history | run dir | `--stop-status` (default `graceful`) | 0; 9 ledger normalization failure (raw capture preserved) | run exists | none | CORE |
| `./scripts/agent-observability doctor [--json]` | end-to-end local OTLP capability with synthetic payload containing **fake secrets** (sanitization proof) | temp dir only | `--json` | 0/1 mapping to AVAILABLE/NOT_CONFIGURED/BLOCKED/BROKEN statuses | python3; free OTLP port | none | CORE |
| `./scripts/agent-observability config` | read-only diagnosis + the exact `[otel]` block targeted at the resolved **product** `CODEX_HOME`; refuses to print an actionable destination when the product identity is unknown/corrupt | no | — | 0; nonzero on corrupt registration | product home resolvable | none | CORE |
| `./scripts/agent-observability install` | download pinned collector, SHA-256 verify, install git-ignored repo-local | `.artifacts/agent-observability/otelcol/` | — | 0; network errors on failure | network | none | CORE mechanism + CONFIG pin |
| `./scripts/agent-observability native-probe` | acceptance/diagnostic probe: one harmless prompt through the same ACP adapter + Codex binary with a temporary overlay `CODEX_HOME` | probe run dir | — | 1; 4 port occupied; 5 no valid Codex home (or ambiguous) | authenticated standalone Codex home; free port | none | CORE |
| `./scripts/agent-observability ledger [run-id] [--json]` | normalize one run (default latest) into `run-ledger.json`; deterministic, idempotent | `run-ledger.json` | run-id, `--json` | 0; 2 usage; 6 run dir missing; 7 manifest missing/malformed; 8 verification attribution mismatch | run exists | none | CORE |
| `./scripts/agent-observability annotate <run-id> --correction yes\|no ...` | append one explicit post-hoc human annotation | `annotations.json` | `--category` (required with yes), `--note` (≤280), `--classification`, `--for-failure` | 0; 2 usage | run exists | none | CORE |
| `./scripts/agent-observability context current\|<run-id> --task-type T --session M` | attach bounded structured run context (idempotent, partial) | `run-context.json` | `--task-key`, `--harness-variant` (optional slugs) | 0; 2 validation; 7 corrupt stored context; 10 zero live captures; 11 multiple | run exists | none | CORE |
| `./scripts/agent-observability current-run` | read-only deterministic resolver for the single live product capture; prints run id | no | — | 0; 10 zero; 11 multiple | python3 | none | CORE |
| `./scripts/agent-observability product-runtime register\|show` | record/show the bounded product-agent identity (product `CODEX_HOME`) | `product-runtime.json` (git-ignored) | — | 0; 5 `CODEX_HOME` unset (register never infers); 7 corrupt (show) | register: run from inside a product-agent session | none | CORE |
| `./scripts/agent-product-launch install` | one-time host integration: byte-identical backup + trampoline + config | **outside the repo** (`~/.local/bin`, `~/.local/share/lucid-codex-acp/`) | — | 0; 2 usage | original launcher present at `~/.local/bin/lucid-codex-acp` | none | HOST INTEGRATION |
| `./scripts/agent-product-launch status` | read-only integration report (trampoline + delegate + config consistency) | no | — | 0 consistent; 7 not installed; 8 inconsistent | — | none | HOST INTEGRATION |
| `./scripts/agent-product-launch uninstall` | byte-exact rollback of the host integration | outside the repo | — | 0; 7 not installed | — | none | HOST INTEGRATION |
| `./scripts/agent-product-launch launch <args…>` | internal wrapper entrypoint (called by the trampoline); guards + opt-out + relay exec | no (execs delegate; same pid) | original launcher args forwarded verbatim | 2 no delegate; 125 recursion guard; else the child's exit status | install (or delegate env) | none | HOST INTEGRATION bridge |

### 6.2 Targeted development commands (scoped AGENTS.md ladders)

**PROJECT-SPECIFIC CONFIGURATION.** From `apps/api/AGENTS.md` and
`apps/web/AGENTS.md` (the "targeted-before-broad" rung):

- Frontend: `npm run typecheck`; `npm run test:unit --workspace=web --
  <spec> [-t "<testname>"]`; `npm run lint`; `npm run build`.
- Backend (from `apps/api/`): `uv run python manage.py check`; `uv run
  python manage.py makemigrations --check --dry-run`; `uv run python
  manage.py test <app-or-test-path>` (app, module, class, or single method).
- Targeted E2E: `FG_ALLOW_E2E_RESET=1 ./scripts/agent-verify.sh e2e
  <spec>` (Playwright args pass through); `npx playwright test --list`
  starts no server and performs no reset.

### 6.3 Human setup/dev commands (root `README.md`)

**PROJECT-SPECIFIC CONFIGURATION.** No bootstrap script exists; setup is a
documented manual sequence: Docker Postgres 16 container
(`fg-postgres`, localhost:5432), `nvm use` (Node 24 per `.nvmrc`) + `npm ci`
at repo root (workspaces), `uv sync` in `apps/api`. Dev servers: Django
`http://127.0.0.1:8000`, Vite `http://localhost:5173`; E2E dev servers:
Django `127.0.0.1:8010` (settings_e2e) + Vite `127.0.0.1:4173`.

---

## 7. Environment Doctor architecture

**CURRENT IMPLEMENTATION.** Canonical source: `scripts/agent-doctor.sh`
(behavioral contract: `scripts/tests/agent-doctor.test.sh`; status-value
documentation: `docs/living-lab.md` "Environment doctor").

### 7.1 Capability model

The doctor runs 16 fixed-order probes and reports one status per capability:

| # | Capability | Checks |
|---|---|---|
| 1 | `repo_workspace` | git worktree + workspace writability |
| 2 | `node_runtime` | Node.js ≥ 24 (engines contract) |
| 3 | `npm` | npm package manager |
| 4 | `uv_runtime` | uv present |
| 5 | `python_runtime` | Python ≥ 3.12 (prefers `apps/api/.venv`) |
| 6 | `frontend_deps` | `node_modules` with the packages the frontend gates need |
| 7 | `backend_deps` | `apps/api/.venv` with django / djangorestframework / psycopg |
| 8 | `database` | PostgreSQL reachability; the only statement is a read-only `SELECT 1` |
| 9 | `frontend_gate` | derived: `node_runtime` + `npm` + `frontend_deps` |
| 10 | `backend_gate` | derived: `uv_runtime` + `backend_deps` + `database` |
| 11 | `quick_gate` | derived prerequisites of the `quick` profile (no DB) |
| 12 | `playwright_runtime` | `@playwright/test` + installed Chromium executable |
| 13 | `chromium_launch` | bounded headless launch preflight (`about:blank`, then closed; no product page, no data) |
| 14 | `e2e_gate` | derived prerequisites of the `e2e` profile; the doctor never sets `FG_ALLOW_E2E_RESET` and never touches `fg_e2e` |
| 15 | `network` | deterministic TCP probe (registry.npmjs.org:443) + proxy-env observation |
| 16 | `agent_observability` | **OPTIONAL**: local otelcol collector present/working |

Derived gates use worst-status precedence: `unavailable > blocked >
unknown > available`, and report the missing prerequisites as
`name(status)` pairs.

### 7.2 Status semantics and output

- Status values: `available`, `unavailable` (component/dependency
  missing), `blocked` (present but unusable here: sandbox/policy, failing
  browser launch, auth failure), `unknown` (not determinable without
  mutation or extra context).
- Human mode: capability matrix. JSON mode (`--json`): stable schema
  (`schemaVersion` 1), stable capability order, `summary.overall` = `ok`
  only when every **required** capability is available, else `degraded`.
- Exit codes: 0 all available; 1 completed with ≥1 non-available; 2 usage;
  3 internal doctor failure.
- **Optional capability rule**: `agent_observability` is reported but never
  gates the result/exit code unless `FG_DOCTOR_REQUIRE_OBSERVABILITY=1`.

### 7.3 Hard read-only contract

No tests executed; no services or browsers left running (the Chromium
preflight closes the browser before continuing); no dependency installs; no
working-tree/git/database mutation (database = connect + `SELECT 1` only);
output never contains secrets or full environment dumps (the launch-error
sanitizer strips ANSI, temp paths, `--user-data-dir`, and pids; details are
truncated to 240 chars).

### 7.4 Relationship to verification; why doctor evidence is not product evidence

- The doctor is **not** part of any `agent-verify` profile; it is a
  preflight/capability tool. A green doctor proves nothing about product
  behavior; a `chromium_launch: available` preflight is
  RUNTIME_VERIFIED **for the launch capability only**, never for any
  product path (Evidence contract level rule).
- On a blocker, the environment budget applies (one attempt, one
  diagnosis-informed retry, then ENVIRONMENT_OR_HARNESS +
  NOT_VERIFIED_ENVIRONMENT_BLOCKED with the exact external command). The
  doctor never installs, and agents must not start installing to unblock a
  gate.
- `agent-observability start` consumes the doctor as evidence: it stores a
  read-only `agent-doctor.sh --json` snapshot into the run directory
  (DEGRADED is stored as evidence; a failed doctor leaves no file; capture
  never aborts on the doctor).

### 7.5 Adapting the doctor for a second repository

**PORTABILITY TARGET / RECOMMENDED FUTURE ARCHITECTURE.** Keep: the
capability/status model, the derived-gate precedence, the optional-capacity
mechanism, the JSON schema shape, the exit-code contract, the read-only
guarantees, and the cause-sanitization rule. Replace per-repo: the probe
list and versions (runtimes, package managers), the dependency-presence
checks, the service reachability check, the browser check, and the
gate→profile mapping. The probes must remain cheap, deterministic, and
mutation-free in the new repo too.

---

## 8. Verification architecture

**CURRENT IMPLEMENTATION.** Canonical source: `scripts/agent-verify.sh`
(contract: `scripts/tests/agent-verify.test.sh`; policy:
`docs/agent/WORKFLOW.md` "Flow" + "CI gates").

### 8.1 Profile model and phase ladder

Profiles are ordered phase lists executed deterministically, sequentially,
with no retries and no parallelism; a failing phase aborts with that phase's
own exit status. One source of truth: the profile functions feed both run
and `plan` output.

| Phase (name) | Command (announced) | Mutates |
|---|---|---|
| `repo: hygiene` | `git diff HEAD --check` | none |
| `frontend: typecheck` | `npm run typecheck` | none |
| `frontend: lint` | `npm run lint` | none |
| `frontend: unit tests` | `npm run test:unit --workspace=web` | none |
| `frontend: token contract` | `npm run test:tokens --workspace=web` | none |
| `frontend: build` | `npm run build` | build output only (`dist/`, gitignored) |
| `backend: django check` | `cd apps/api && uv run python manage.py check` | none |
| `backend: migration drift` | `cd apps/api && uv run python manage.py makemigrations --check --dry-run` | none |
| `backend: django tests` | `cd apps/api && uv run python manage.py test` | Django test database only (created + dropped; development database untouched) |
| `e2e: playwright` | `npm run test:e2e [args]` | **DESTRUCTIVE: resets `fg_e2e` schema (DROP SCHEMA CASCADE + migrate + seed); writes `playwright-report/` and `test-results/`** |

Profiles: `quick` = hygiene + typecheck + lint + django check + migration
drift. `frontend` = the five frontend phases. `backend` = the three backend
phases. `core` = hygiene + frontend + backend. `e2e` = the e2e phase.
`full` = core + e2e.

Targeted-before-broad ladder (policy): targeted subset during development
(scoped AGENTS.md ladders, §6.2) → `quick` after structural edits
(sandbox-safe) → complete `frontend`/`backend` → `core` before completing a
non-browser slice → `e2e`/`full` only in a browser-capable environment with
explicit reset consent.

### 8.2 `plan` mode

`./scripts/agent-verify.sh plan <profile>` prints the profile's exact phase
list, announced commands, mutation classification, and environment
requirements **without executing anything** and without mutating. It
rejects `--summary-json`. It is the way to inspect a profile's contract.

### 8.3 E2E refusal

Without exactly `FG_ALLOW_E2E_RESET=1`, the `e2e`/`full` profiles refuse
**before any server starts or database state changes** (exit 2) with the
exact consent command. The refusal is redundant-by-design: the choke point
is `reset_e2e` itself (§12), so every invocation path is protected.

### 8.4 Summary JSON (`--summary-json`)

Exactly one versioned JSON file (`schemaVersion` 1) at the explicit target
path, written after a run-mode profile on **both** pass and fail-fast.
Contract (pinned by `agent-verify.test.sh`):

- Target directory must already exist and be writable; the path must be a
  regular file if it exists; nothing is created (no parent directories);
  relative paths resolve against the caller's CWD.
- Content: profile, result, real exit code of the failed phase (or overall
  0), started/finished, duration, `agentRunId` (see §8.5), and one entry per
  phase: announced command, outcome (`passed`/`failed`/`not_run`), real
  `exitCode` (null for not_run), duration.
- Fail-fast: the failed phase is recorded with its real exit code; all
  later phases are `not_run`.
- Human output and exit codes are unchanged with or without the flag; no
  file is written without it; plan mode rejects the flag; no secrets or
  environment values appear in the summary.

### 8.5 Run-ID correlation (verification ↔ observability)

Three tiers, deterministic, **never timestamp-guessed**:

1. **Explicit** — `FG_AGENT_RUN_ID=<run-id>` is authoritative; recorded as
   `agentRunId`. The ledger later *rejects* a summary whose `agentRunId`
   does not equal the run id (exit 8).
2. **Session/run mapping** (automatic product path) — when
   `CODEX_SESSION_ID` is set and
   `.artifacts/agent-observability/session-runs/<CODEX_SESSION_ID>`
   (overridable via `FG_PRODUCT_SESSION_MAP_DIR`) stores a run id whose run
   dir exists, that is exactly this session's active-turn run. No liveness
   scan, no guessing.
3. **Single active capture** (manual start/stop path) — builtins-only
   `kill -0` pidfile discovery over `FG_OBS_RUNS_DIR` (default
   `<repo>/.artifacts/agent-runs`) restricted to manifest kind `capture`
   (probes never count): zero → `agentRunId: null`; multiple → refused
   (exit 2, no summary). **KNOWN LIMITATION**: because the probe is
   builtins-only (must work under the restricted test PATH, no Python
   dependency), a controller-owned capture the agent cannot signal (EPERM)
   is treated as absent — tier 3 is same-identity only. For reliable
   cross-identity correlation, resolve the id with
   `./scripts/agent-observability current-run` and export `FG_AGENT_RUN_ID`.

`agent-verify.sh` is deliberately decoupled from the Python liveness helper
so it never depends on observability being installed.

### 8.6 Relationship to CI; meaning of the final gate

CI runs exactly the canonical profiles (§11). Local `core` passing ≙ CI
core gate (same commands, same environment contract); a passing `core`
proves nothing about browser behavior. `full` is the genuinely complete
gate: it cannot pass without actually running E2E with consent. A summary
JSON is execution evidence only — it never confers RUNTIME_VERIFIED.

### 8.7 The five evidence statuses

**CURRENT IMPLEMENTATION** (canonical: `docs/agent/WORKFLOW.md` "Evidence
contract"; this table summarizes; the document owns the full semantics).

| Status | Meaning | Required evidence | Never follows |
|---|---|---|---|
| IMPLEMENTED | code was written | the changed file paths | any correctness/behavior/passing claim |
| STATICALLY_VERIFIED | executed checks that passed, static only (search, diff/whitespace, typecheck, lint, parse, Django system check, migration drift, build) | exact command + observed PASS/exit 0 | any runtime claim |
| RUNTIME_VERIFIED | the specific claimed runtime behavior was executed and observed | exact command, exit code, executed behavior path (spec+test / endpoint+flow) | never derivable from static checks; each level proves only the level executed |
| NOT_VERIFIED_ENVIRONMENT_BLOCKED | verification could not run; concrete blocker reproduced | reproduced blocker (doctor JSON or exact error) + exact external command | anything about the path; must never be phrased as verified/green |
| NOT_RUN_OUT_OF_SCOPE | gate deliberately not run for this slice | named omitted gate(s) + why | anything about the gate's current state; scope must not mask a regression |

What may upgrade a status: only executing the higher level (static →
runtime requires executing the runtime path). What may never upgrade a
status: narrative summaries, summary-JSON existence, artifact upload, CI
queue position, or doctor preflight. A row with product path executed
`no` must not carry RUNTIME_VERIFIED.

---

## 9. Failure classification

**CURRENT IMPLEMENTATION** (canonical: `docs/agent/WORKFLOW.md`; the four
classes are also the closed enum in the ledger's annotation contract,
`docs/agent/ledger-contract.json`).

Every failed or suspicious verification result is classified **before** any
next action. A classification states exactly one class, the concrete
evidence, whether the product path was actually reached, and the allowed
next action.

| Class | When (definition) | Evidence used | Permitted next action | Common anti-pattern |
|---|---|---|---|---|
| PRODUCT_REGRESSION | an executed product/test path failed because of product behavior (assertion on documented behavior or previously green expectation fails in the product) | failing command + output identifying the failing assertion/step + the contradicted documented invariant | stop and report; repair only via a dedicated bug task or explicitly authorized repair; **never weaken the test or change product copy to pass** | "fixing" the assertion to green without checking the invariant |
| STALE_TEST | the test/harness no longer matches currently documented intended behavior (stale selector/outdated fixture) while product behavior remains as documented | FACT that product behavior matches the documented invariant + the exact stale assertion/selector | update the stale selector/assertion (behavior unchanged), re-run, report | using `.first()` to silence strict-mode ambiguity as if it were a fix |
| ENVIRONMENT_OR_HARNESS | failure originates in environment/harness (browser launch, DB unreachable, missing dependency, sandbox policy, harness crash), not product | doctor/preflight output naming the blocked capability + why the product path is not the cause (how far the run got) | environment budget, then report NOT_VERIFIED_ENVIRONMENT_BLOCKED with the exact external command; no install/retry/escalation loops | chasing an environment blocker as a bug; installing to "fix" it |
| SCOPE_DISCOVERY | verification reveals a gap/regression/behavior outside the task's Definition of Done | concrete observation (command + output) + why it is outside the slice | report + propose a dedicated task; do not fix opportunistically unless authorized | silently expanding the slice to "also fix" the discovery |

Hard rule: **tests must not be weakened merely to obtain green results** —
weakening is a PRODUCT_REGRESSION-class violation, not a STALE_TEST update.
A stale selector may be updated only when product behavior remains
unchanged (the verification boundary).

**CURRENT session vs NEW session** (from the classification outcome):

- Stay in **CURRENT** session: same root cause, direct continuation — e.g.
  a STALE_TEST selector update for the slice you are already fixing; a
  scoped re-run after a diagnosed environmental cause within budget.
- Start a **NEW** session/slice: a PRODUCT_REGRESSION (dedicated bug task),
  a SCOPE_DISCOVERY (dedicated task), a new feature/domain/root cause, or
  after substantial debugging has polluted the working context. A
  classified ENVIRONMENT_OR_HARNESS gate is not a debugging exercise — it
  is a classified status, reported and moved on from.
  is a classified status, reported and moved on from.

---

## 10. Work slicing and commit/checkpoint discipline

**CURRENT IMPLEMENTATION** (canonical: root `AGENTS.md` "Working method",
`docs/agent/WORKFLOW.md` "Branch workflow" / "Stop rules").

### 10.1 Slicing rules

- **One dominant engineering outcome per slice** — one independently
  verifiable product outcome; slices are short enough that verification is
  proportional.
- **Domain/API/client/interaction ordering** — durable changes flow
  documentation → backend model/migration → API contract → frontend →
  tests (the `docs/README.md` change-discipline chain); interaction and
  stabilization slices follow.
- **CURRENT vs NEW sessions** — see §9 table and `docs/agent/WORKFLOW.md`
  "Session guidance": CURRENT for the same root cause/direct continuation;
  NEW for a new feature/domain/root cause or after substantial debugging.
- **Acceptance-boundary thinking** — a slice is done when its Definition of
  Done is verified at the required width; deliberately omitted gates are
  still named (NOT_RUN_OUT_OF_SCOPE rows).
- **WIP complexity guard** — the smallest coherent change; no unrelated
  refactors, no pre-emptive future steps, no unapproved dependencies
  (scope control list in the root `AGENTS.md`).

### 10.2 Commit gate and branch workflow

**CURRENT IMPLEMENTATION** (branch policy is **project-process policy**;
the mechanism it relies on — the verification ladder and `git diff
HEAD --check` — is generic harness).

1. Every file-changing task starts on its own short-lived slice branch;
   `main` is the last fully integrated and verified state; read-only audits
   may run on clean `main`.
2. Before commit: the slice is verified locally and targeted — `git diff
   HEAD --check` clean, `core` for non-browser slices (E2E where required).
3. **Stage exact files** (never blanket staging that could absorb
   unrelated WIP), **inspect the staged diff**, commit.
4. Push; integrate into `main` by local fast-forward merge after the commit
   gate (no mandatory PRs in the current solo workflow).
5. Verify clean tree and `HEAD == origin/main`; the slice branch is deleted
   only after the remote CI evidence passed.
6. Git discipline (root `AGENTS.md`): no commit/push/rebase/reset/history
   rewrite unless explicitly asked; no lockfile changes unless
   dependencies actually changed; unrelated user changes in a dirty tree
   are preserved, never reverted.

---

## 11. CI architecture

**CURRENT IMPLEMENTATION.** Two workflows, both in `.github/workflows/`,
each a single job on a pinned `ubuntu-24.04` runner against an isolated,
health-checked `postgres:16` service container (CI-only, non-secret
credentials `fg_ci`/`fg-ci-only`, DB `fg_workspace`). Triggers:
`pull_request` → `main`, `push` → `main`, `workflow_dispatch`.
`permissions: contents: read`. Concurrency cancels superseded PR runs only
(pushes to `main` are queued, never cancelled). All action references are
pinned to full 40-char commit SHAs. The repository does **not** configure
branch protection: these gates are advisory checks (a current documented
fact, `docs/agent/WORKFLOW.md` "Branch workflow": "Branch protection is
deliberately disabled in the current solo/early phase").

### 11.1 Mapping: CI job → canonical local command → prerequisites → evidence

| CI job | Canonical local command (the only gate invocation) | Capability/state prerequisites | Evidence produced |
|---|---|---|---|
| `core.yml` → `Core verification` (30 min) | `./scripts/agent-verify.sh --summary-json "$RUNNER_TEMP/fg-core/core-summary.json" core` | Node 24 (`npm ci` from lockfile), uv 0.12.16 + Python 3.12 (`uv sync --frozen`), Postgres 16 reachable (health-checked); **no** Playwright browser installed | core run summary JSON (kept on success AND failure, never on cancellation; 14-day retention, repository-readers-only access) |
| `e2e.yml` → `Playwright E2E (chromium)` (20 min) | `FG_ALLOW_E2E_RESET=1 ./scripts/agent-verify.sh --summary-json "$RUNNER_TEMP/fg-e2e/e2e-summary.json" e2e` | same setup **plus** `npx playwright install --with-deps chromium`; the destructive-reset consent is set in the workflow and **only there** (reset touches only the isolated `fg_e2e` schema) | e2e run summary JSON (same retention/cancellation rules) + on failure only: `playwright-report/` + `test-results/` as the `e2e-failure-…` artifact (never on cancellation) |

Rules pinned by the static contract tests (`core-workflow.test.sh`,
`e2e-workflow.test.sh`): exactly one canonical invocation per workflow (no
direct `npm run test:e2e` / `playwright test` gate call); `FG_ALLOW_E2E_RESET`
appears exactly once, on the canonical gate line; no `pull_request_target`,
no schedule/workflow_run/release triggers; reproducible setup (`npm ci`,
`uv sync --frozen`, lockfile only); upload matrix exactly
`!cancelled()` for summaries and `failure() && !cancelled()` for failure
artifacts. An uploaded artifact is never gate success; a cancelled run is
never presented as successful evidence; the JSON summary never confers
RUNTIME_VERIFIED.

Relationship local ↔ CI: CI executes the *same canonical commands* a local
agent runs, in the strongest non-browser and browser forms, so local
`core`/`e2e` results are directly comparable to CI results (same phase
lists, same consent model). Divergence between local and CI is a
STATE/environment question, not a contract question — the contracts are
identical by construction (see §39).

---

## 12. E2E and deterministic state architecture

**PROJECT-SPECIFIC CONFIGURATION** (Django/Playwright/seed specifics)
wrapped in **CURRENT IMPLEMENTATION** mechanics; the *pattern* is portable
(§33).

### 12.1 State reset model

- E2E runs against an **isolated PostgreSQL schema `fg_e2e`**
  (`apps/api/config/settings_e2e.py` forces `search_path=fg_e2e`); the
  development schema and data are never touched by E2E.
- The Playwright `webServer` startup (`playwright.config.ts`) runs, in
  order: `DJANGO_SETTINGS_MODULE=config.settings_e2e uv run python
  manage.py reset_e2e`, then the same-settings `runserver 127.0.0.1:8010
  --noreload`, and in parallel `npm run dev:e2e --workspace=web` (Vite
  `vite.e2e.config.ts`, port 4173). `reset_e2e` performs:
  `DROP SCHEMA IF EXISTS fg_e2e CASCADE` → `CREATE SCHEMA fg_e2e` →
  `migrate` → `seed_dev` → `seed_e2e_scope`.
- Every E2E run therefore starts from the **same deterministic baseline**:
  identical migrations + identical seed, regardless of prior state.

### 12.2 Destructive-reset consent mechanism

The consent is enforced at the **choke point**, not only in
`agent-verify.sh`: `reset_e2e` itself refuses (clear error, nonzero exit)
unless **both** `DJANGO_SETTINGS_MODULE=config.settings_e2e` and exactly
`FG_ALLOW_E2E_RESET=1` are set — missing, empty, or any other value is
refused. The refusal happens **before any schema drop, migration, or
seed**, so every invocation path is protected: `agent-verify e2e/full`,
`npm run test:e2e`, `npx playwright test`, and direct management-command
calls. Playwright `--list` starts no web server and performs no reset.
Behavior tests: `apps/api/accounts/test_reset_e2e.py`.

### 12.3 Fixtures / test users

- `seed_dev`: deterministic users `alex`, `chris`, `maria`, `laura`
  (`<user>@example.com`, `SEED_PASSWORD` env, default `DevPass1!`), a
  Research Group ("FG Example"), group memberships, and two Projects
  ("Paper XYZ": alex owner / chris member; "Teaching Tool": maria owner /
  laura member) with representative Work Items — the Living-Lab synthetic
  baseline documented in `docs/living-lab.md`.
- `seed_e2e_scope`: E2E-specific scope fixtures (cross-group/cross-project
  visibility scenarios for the authorization specs).
- Seed data obeys the same domain rules as normal data (it is not a second
  business-logic implementation).

### 12.4 Browser preflight and determinism

- Doctor preflights the browser (bounded headless launch, then closed) so
  E2E failures are classified before they happen (§7).
- Playwright runs **serially** (`workers: 1`, `fullyParallel: false`);
  `fullyParallel: false` + single worker + single reset at startup is what
  makes the baseline deterministic; **no parallel E2E** is supported or
  assumed (parallelism would break the shared-schema baseline).
- Browser: chromium only (single project `chromium`).

### 12.5 Evidence and artifact collection

- Built-in Playwright artifacts are canonical: `trace: retain-on-failure`,
  `screenshot: only-on-failure`, HTML report (`playwright-report/`,
  `test-results/`).
- On top, an *unexpectedly* failed test may carry a bounded, secret-poor
  `failure-diagnostics.json` (schemaVersion 1; test identity, observed vs
  expected status, sanitized last URL, bounded `pageErrors` /
  `consoleErrors` / `requestFailures` / `httpErrors`, optional compact ARIA
  snapshot; excluded by contract: bodies, headers, cookies, storage, env,
  tokens; bounds 20 entries / 500 chars / 8,000-char snapshot / 64 KiB
  total). Fixture: `e2e/diagnostics/failure-diagnostics.ts`; browser-free
  logic tests: `e2e/diagnostics/unit/` via
  `npx playwright test -c playwright.diagnostics.config.ts`. Currently
  active for `e2e/research-group-scope.spec.ts` only; migrating further
  specs is a per-spec decision.
- CI uploads the failure artifacts as a separate artifact on failure only
  (§11.1).

### 12.6 How E2E differs from static/unit verification

E2E is the only profile that exercises the real browser + real server +
real (reset) database together; it is the only source of browser
RUNTIME_VERIFIED evidence. Static profiles and unit suites can never
upgrade to browser evidence. Conversely, E2E never replaces the complete
non-browser `core` profile — `full` = both.
non-browser `core` profile — `full` = both.

---

# OBSERVABILITY — COMPLETE SPECIFICATION

Sections 13–26. Canonical detail sources: `docs/agent/OBSERVABILITY.md`
(narrative), `scripts/observability/*` (implementation),
`docs/agent/trace-contract.json` + `docs/agent/ledger-contract.json`
(contracts), `scripts/tests/agent-observability.test.sh` +
`scripts/tests/agent-product-launch.test.sh` (behavioral pins).

## 13. Observability goals and non-goals

**CURRENT IMPLEMENTATION.**

Goals:

- Normal product-agent sessions can emit **native Codex OpenTelemetry**
  events into a **local, privacy-conscious, git-ignored trace store**, so
  later harness improvements (Run Ledger, normalized metrics) are based on
  observed behavior instead of anecdotes.
- Answer diagnostic questions: what model/version/effort/sandbox/approval
  policy did this turn run under; which tools failed and when; how many
  tokens/timing; what was the git WIP state at start/end; which
  verification/doctor evidence belongs to this run; was a human correction
  needed (explicit annotation only).

Non-goals (deliberate):

- **No dashboards, no aggregate analytics, no cross-run quality
  analytics.** The Run Ledger (§22) is the normalized *per-run* record
  above the capture layer; cross-run analytics are a later stage that will
  consume ledger records only. **KNOWN LIMITATION**: cross-run
  dashboarding does not exist, and the capture/ledger infrastructure is
  not a substitute for it.
- No cloud vendor, no external telemetry backend — the only OTLP
  destination is a loopback collector on the local machine.
- No monkey-patching of Codex/codex-acp; the repository owns only the
  collector configuration, scripts, schemas, tests, and documentation.
- No product code changes, no Eval changes (`evals/` untouched).
- **Product observability ≠ Eval**: product observability records *normal*
  product-agent work for harness improvement; Eval (§41) measures *pinned
  historical states* against hidden acceptance checks. They share only the
  per-run runtime-metadata field contract (`docs/agent/RUNTIME.md`).
- **Run telemetry ≠ cross-run analytics**: a run's ledger is one
  normalized record; nothing currently compares runs automatically
  (comparability §24 only records *which dimensions exist*).

## 14. Current product runtime topology

**CURRENT IMPLEMENTATION.** Verified execution chain (the product path):

```text
Lucid / PyCharm (ACP client)
   → host trampoline ~/.local/bin/lucid-codex-acp            [HOST INTEGRATION]
     → scripts/agent-product-launch launch (repo wrapper)
       → scripts/observability/acp-lifecycle-relay.py (exec'd: same pid)
         → original launcher (byte-identical delegate, e.g. the Lucid
           codex-acp launcher under ~/.local/share/lucid-codex-acp/)
           → @agentclientprotocol/codex-acp 1.7.0 (ACP protocol v1)
             → codex-policy-guard.py (host-side guard; not repo-owned)
               → Codex app-server 0.148.x (the captured product Codex)
```

Host-instance snapshot (read-only, at verification time — **host examples,
not universal architecture**): product `CODEX_HOME` =
`/Users/leo/.codex-lucid` (resolved via the live product session's
`CODEX_HOME`), registered identity `codex_path` =
`~/.local/share/lucid-codex-acp/codex-policy-guard.py`, `codex_acp_version`
= 1.7.0, collector `otelcol-contrib 0.161.0` running on
`127.0.0.1:4318`, relay active for the product session (relay event log
writing). The exact trampoline state of the host integration could not be
runtime-verified from the agent sandbox (the host directories are not
sandbox-readable); `agent-product-launch status` therefore must be read
from the controller shell to be authoritative.

### 14.1 Three Codex identities that must never be conflated

| Identity | What it is | Used for |
|---|---|---|
| **Product `CODEX_HOME`** | the host-managed home the normal product agent actually runs in (e.g. `~/.codex-lucid` here) | the ONLY home that matters for product telemetry; Codex reads `[otel]` only from the *user-level* config of this home |
| **Controller / standalone Codex** | what generic `~/.codex*` discovery finds in the developer shell (e.g. `~/.codex`) | `native-probe`'s standalone authenticated home; `status` shows it *informationally only* — never as the product destination |
| **Product-runtime registration** | the bounded identity the product-agent session records: `schema_version`, `codex_home`, `codex_path`, `codex_acp_version` in git-ignored `.artifacts/agent-observability/product-runtime.json` | the bridge that lets an ordinary controller shell target the product home without guessing |

The product home is established **only from evidence**, in precedence:
(1) `FG_PRODUCT_CODEX_HOME` explicit override; (2) live `CODEX_HOME`
environment (the host exports it to the product process); (3) the
persisted product-runtime registration; (4) otherwise `not_registered` /
`corrupt` — fail closed. A home that is merely unreadable in the current
environment (e.g. inside the agent sandbox) is reported `not_checked`,
never re-guessed. Repository-local `.codex/config.toml` **cannot** enable
OTel and is never presented as a valid solution.

## 15. Host integration

**CURRENT IMPLEMENTATION** (repo side) + **HOST INTEGRATION** (machine
side).

### 15.1 Install / status / uninstall model

`scripts/agent-product-launch install` — one-time, idempotent:

- backs up the original launcher **byte-identically** (mode kept,
  `cmp`-verified) to `~/.local/share/lucid-codex-acp/lucid-codex-acp.impl`;
- atomically replaces `~/.local/bin/lucid-codex-acp` with a small
  **trampoline** that exports the explicit delegate path and execs the repo
  wrapper;
- writes the user-level config
  `~/.local/share/lucid-codex-acp/agent-product-launch.json`
  (`schema_version` 1: repo root, entrypoint, delegate);
- all writes are atomic renames; a post-install consistency check verifies
  trampoline + delegate + config agree; never touches auth, never embeds
  secrets.

`status` — read-only integration report. Exit 0 consistent, 7 not
installed, 8 inconsistent. `uninstall` — restores the original launcher
byte-identically (`cmp`-verified) and removes config + backup; idempotent;
this is the rollback path.

### 15.2 Trampoline/delegate relationship, ownership, recursion

- Ownership: the trampoline + config + backup live **outside the
  repository** (user-level `~/.local/...`); the wrapper, relay, and all
  capture logic live **inside** the repository. The trampoline is a thin
  forwarder: it only names the delegate and execs the wrapper — no logic.
- Recursion is impossible by construction: the wrapper fails closed
  (exit 125) when the delegate resolves to the wrapper itself or to a
  trampoline (marker check on the file head), and the internal environment
  guard `FG_PRODUCT_OBS_IN_WRAPPER` catches any nested invocation.
- **Fail-open degradation**: if the trampoline ever runs while the wrapper
  is missing, it reports one bounded stderr warning and executes the
  original launcher with the original arguments — the product keeps
  working; capture is unavailable until the wrapper is restored.

### 15.3 What is modified outside the repository; rollback; restarts

- Modified outside the repo: exactly three paths — the launcher path
  (`~/.local/bin/lucid-codex-acp`), its backup, and the config file.
- Rollback: `uninstall` (byte-exact restore) or, for the degraded case, the
  trampoline's own fallback to the delegate.
- Host assumptions: the Lucid host launches the agent through
  `~/.local/bin/lucid-codex-acp` (the ACP launcher on PATH); `python3` is
  available (else the launch path degrades to direct exec — no relay, no
  capture); the original launcher's argument interface is unchanged
  (forwarded verbatim).
- After repository code updates: the trampoline keeps pointing at the repo
  wrapper path; **new relay/wrapper behavior takes effect on the next
  launcher process start** (the long-lived ACP server must be restarted —
  the next fresh Lucid ACP server process picks up the updated scripts;
  already-running processes keep the old code).
- Process restart requirements: the collector is a normal local process
  (no daemon; does not survive reboots; reaped when the spawning sandbox
  command ends — start it from the controller shell for manual runs);
  product Codex reads `[otel]` at process start, so a config change needs a
  **new agent session**.

### 15.4 Mandatory distinction

**CURRENT IMPLEMENTATION**: the host integration, once installed by
`scripts/agent-product-launch install`, **points back into THIS
repository** — the trampoline execs `scripts/agent-product-launch launch`
*of this repo*, the relay resolves the repo root from its own file path,
and the config file stores this repo's root. One host ↔ one repository,
by construction.

**PORTABILITY TARGET / RECOMMENDED FUTURE ARCHITECTURE**: with several
repositories, a per-repo host integration is the wrong shape — the Lucid
client has a single launcher path, so two repos cannot both own
`~/.local/bin/lucid-codex-acp`, and reinstalling per repo causes churn and
drift. The multi-repository solution must make the host integration
**global/shared**: one host-level integration that dispatches to the
*currently active* repository (working-directory → repo-root resolution)
and shares one collector/install state, while each repository contributes
only its configuration and knowledge (§31). Until that exists, installing a
second repository's integration would clobber the first — see §33
("Host setup that must not be installed twice").

## 16. ACP transport and relay architecture

**CURRENT IMPLEMENTATION.** Canonical source:
`scripts/observability/acp-lifecycle-relay.py` (behavioral pins:
`scripts/tests/agent-product-launch.test.sh` + the framer units in
`scripts/tests/fixtures/ndjson-framer-units.py`).

### 16.1 Transport contract

- The ACP stdio wire is **newline-delimited JSON (NDJSON)** — one JSON-RPC
  message per line. The relay pumps client stdin → child stdin and child
  stdout → client stdout **byte-for-byte**, preserving framing and
  backpressure. `stdout` carries ACP bytes only; every diagnostic goes to
  stderr.
  Exactly one ordering exception: the bytes of a CAPTURABLE
  `session/prompt` line are HELD (never modified, never dropped) from
  turn start until the turn's start contract confirms the collector is
  accepting OTLP — `started`, or the fail-open outcomes
  (`already_running` / error / timeout) — and are then forwarded
  unchanged; no other ACP message is held (§17.2, readiness ordering).
- *Fragmentation*: bytes arrive in arbitrary chunks; the wire observer
  (`NdjsonFramer`) reassembles lines across chunk boundaries.
- *Multi-line reads*: several JSON-RPC lines in one read are all observed.
- *Oversized lines*: at most 256 KiB (`MAX_LINE`) of one line are retained
  for observation; a line beyond the bound — whether it completes or is
  still arriving — is **skipped for that line only**: one bounded
  `frame-skipped … reason=line-oversized` diagnostic, no payload handed to
  the observer, observation resumes on the next line. The stream is never
  disabled.
- *Malformed JSON*: the line is forwarded unchanged (byte-transparent),
  observation simply yields nothing for it; observation continues.
- The relay parses only enough of each observed line to read `method`,
  `id`, and `sessionId` (in `params`, or the `session/new` / `session/fork`
  `result`). It never inspects, modifies, logs, or persists prompt or
  content blocks; it retains at most one line at a time.

### 16.2 Why the earlier LSP assumption was wrong (concise rationale)

An earlier design assumed the ACP stdio stream used LSP-style
`Content-Length` header framing. The installed adapter
(`@agentclientprotocol/codex-acp` 1.7.0) speaks newline-delimited JSON-RPC
instead; a `Content-Length`-framed observer would have misparsed every
message. The regression fixtures (`acp-fake-server.py` emitting real
NDJSON traffic, `ndjson-framer-units.py` byte-level framer tests, and the
scenario driver) pin the NDJSON contract: fragmented reads, multi-line
reads, per-line skip boundary, CRLF, blank lines, and long lines.

### 16.3 Bounded diagnostics and privacy

- The ACP server's stderr may be dropped by the client host, so the relay
  appends the same bounded single-line diagnostics to a git-ignored log:
  `.artifacts/agent-observability/relay-events.log` (override
  `FG_PRODUCT_RELAY_LOG`); lines truncated to 1000 chars; file rotates to
  the most recent 128 KiB once it exceeds 256 KiB. Every write is
  best-effort and never breaks or delays the ACP stream.
- The event vocabulary is closed and identifier-only: `relay-started`,
  `relay-exited`, `client-request` (method + id), `server-notification`
  (method name only; the high-volume `session/update` stream is
  suppressed), `server-error` (id), `session-open` / `session-open-ignored`
  / `session-seen`, `open-ignored` / `open-no-session-id` /
  `open-response-incomplete`, `turn-start` / `turn-uncaptured` /
  `prompt-ignored`, `start-result` / `start-error`, `mapping-written` /
  `mapping-write-failed`, `gate-released` (session id + held byte
  count — the held prompt bytes are forwarded now), `turn-response`
  (+`-pending` / `-unmatched` /
  `-late` / `-norun`), `turn-finalize` (+`-during-start` / `-ignored`),
  `close-pending` / `close-launched` / `close-ignored` / `close-unknown` /
  `session-closed`, `stop-result`, `frame-skipped`, `observe-error`.
  Never: prompts, content blocks, tool arguments/results, auth material,
  environment dumps, or ACP bodies.
- Because the first line of every relay lifetime is `relay-started`, the
  log pins the exact failure boundary for "fresh prompt, no run" (full
  decision table in §39).
  log pins the exact failure boundary for "fresh prompt, no run" (full
  decision table in §39).

## 17. Session vs Prompt-Turn lifecycle

**CURRENT IMPLEMENTATION.** The exact semantics (canonical:
`docs/agent/OBSERVABILITY.md` "Automatic product-session lifecycle";
implementation: `acp-lifecycle-relay.py`; pins:
`agent-product-launch.test.sh`).

```text
ACP session   = long-lived conversation / grouping identity (native Codex
                thread id; survives across many prompt turns; Lucid keeps
                it open indefinitely)

session/prompt turn = ONE observability run / one foreground agent work
                unit (request → work → matching response with stopReason)
```

### 17.1 The open methods — identity tracking only, NO run

Verified against installed codex-acp 1.7.0 (`initialize` result advertises
`sessionCapabilities` with `load`, `resume`, `fork`; its source shows
`session/new` is the only handler that creates a thread):

- `session/new` — a FRESH session (what a real fresh Lucid session uses).
  Remembered by request id (bounded pending set); the canonical `sessionId`
  arrives in the response — a short pending state, never an invented id.
- `session/load` / `session/resume` — re-open of an EXISTING thread; the
  `sessionId` travels in the request params (the response carries no id).
  Each re-open is a **fresh root ACP session** and is tracked as such.
- `session/fork` — covered defensively; the response carries the NEW
  `sessionId`; the forked session is tracked as a fresh root ACP session.

Opens track session **identity only** — they start no run.

### 17.2 The prompt turn — the run boundary

- A `session/prompt` request (the relay reads ONLY its request id and
  `params.sessionId` — never the prompt blocks) starts a run:
  `agent-observability start --json` as a short-lived sidecar
  (`started` → mapping written, turn run OPEN; `already_running` → turn
  uncaptured, one at a time; error/timeout → fail open, one bounded
  warning, stream intact). **Readiness ordering (invariant):** the
  collector must be CONFIRMED ACCEPTING on its loopback OTLP endpoint
  BEFORE a captured prompt's bytes are forwarded to the Codex child.
  The `started` contract IS that confirmation — the control surface
  emits it only once the collector's OTLP port is confirmed listening
  (bounded local TCP probe; bounded startup budget; explicit failure
  on exit-before-ready or timeout) — so the relay HOLDS the capturable
  prompt line (byte-intact) from turn start until the contract
  resolves, and forwards it unchanged only then. The turn's first
  telemetry events therefore cannot be lost to collector startup.
  `already_running` and the failure outcomes fail open WITHOUT a
  readiness wait: an uncaptured prompt never waits for a collector it
  does not own. The sidecar also persists `params.sessionId`
  (the native Codex conversation of the ACP session) into the run's
  capture manifest as `captured_conversation_id` at seed time — durable
  run metadata that survives finalization and the release of the
  transient session/run mapping, and the Run Ledger's attribution key
  (§22.2).
- The **matching** `session/prompt` response, correlated by the **EXACT
  request id** (a late or foreign id never touches any run), finalizes the
  run: `agent-observability stop --stop-status graceful`. From that
  response the relay reads only the correlation and `stopReason` (a
  bounded enum string) — never the result content.
- `session/close` / `session/delete` are **cleanup only**: they finalize an
  unexpectedly open turn (response never arrived) as `interrupted` and
  release the session state. A close of a session with no active turn
  finalizes nothing; duplicate closes are harmless no-ops (exactly-once
  finalization); an unknown session close never touches another run.
- Process/transport crash with an active turn: the turn finalizes as
  `interrupted` (fallback boundary, never the normal close); pending
  start/stop sidecars are settled and their contracts consumed before
  finalization, so a run that came up in the same instant as the child
  exited is still named, mapped, and stopped — never orphaned. No collector
  is left orphaned; the relay exits with the child's exit status
  (128+signal when the child died by a forwarded signal).

### 17.3 Graceful vs interrupted — how it is decided

Finalization is decided **only** by the ACP protocol outcome — there are no
idle-time timers, no final-text heuristics, no UI-close dependency, no
timestamp-nearest matching, no newest-run guessing anywhere in the
automatic path:

| Trigger | Finalization |
|---|---|
| prompt response with a result (`stopReason`) | `graceful` |
| prompt response with a JSON-RPC error | `interrupted` |
| `session/close`/`session/delete` before the prompt response | `interrupted` |
| process/transport crash with the turn active | `interrupted` |
| late/duplicate response for an already-finalized turn | bounded no-op (exactly-once) |

Edge contracts: a prompt response that arrives before the start sidecar
resolves finalizes the run with that status as soon as it comes up
(first-to-decide wins: a session close that already arrived is kept as
`interrupted`). A failed mapping write fails open (run live, turn
uncaptured, prompt response still finalizes the run, bounded
`mapping-write-failed` diagnostic). A failed finalization (non-recoverable
write failure) leaves raw evidence untouched and **keeps** the mapping so a
later close or a manual `stop` can re-finalize. Manifest corruption is NOT
a finalization failure — manifest finalize is self-healing (rebuilds from
raw evidence; stop stays green; the ledger records the resulting gaps).
SIGKILL cannot be trapped — an orphaned run is reconciled as `interrupted`
on the next start/stop.

### 17.4 The worked invariant

```text
Prompt A → Run A → graceful finalization (stop_status=graceful, end_ts set,
             end Git evidence, run-ledger.json, mapping released)
Prompt B in the SAME still-open chat → Run B (different run id, no evidence
             from A attributed to B) → graceful finalization
The ACP/PyCharm chat remains open the whole time; no close, no manual
start/stop, no observability command.
```

Signals: INT/TERM/HUP are forwarded once to the child (by pid); further
signals are consumed (single forward, single finalization). The child is
launched through a small pre-exec shim that resets SIGINT to the OS default
(a backgrounded child of a non-interactive shell otherwise inherits SIGINT
IGNORED). The launch path ALWAYS exits with the child's exit status —
observability never replaces it.

Concurrency (**KNOWN LIMITATION**): the capture architecture owns one
loopback endpoint and one capture directory per collector lifecycle, so
exactly **one automatically observed prompt turn is supported at a time**.
A concurrent turn fails open with a bounded warning naming the active run;
it is never attached, overwritten, or merged; a concurrent turn's OTLP (if
any) may still land in the first run's raw capture — and, since Run Ledger
schema v3, that foreign telemetry is reported explicitly by the ledger's
`activity.foreign` diagnostic instead of being merged into the captured
turn's metrics.

## 18. Run identity and correlation

**CURRENT IMPLEMENTATION.** All current identity concepts:

| Concept | Value / form | Owner |
|---|---|---|
| ACP session ID = native Codex thread id = `CODEX_SESSION_ID` | one identifier end-to-end (codex-acp returns `thread.id` as `sessionId`; the same id reaches tool shells as `CODEX_SESSION_ID`) | Codex/adapter (read-only) |
| Prompt request id | the JSON-RPC `id` of the `session/prompt` request | ACP client |
| Observability run id | `run-<UTC timestamp>` (captures), `probe-native-<UTC timestamp>` (probes); = the run directory name | `agent-observability start` |
| Session/run mapping | `.artifacts/agent-observability/session-runs/<session-id>` (override `FG_PRODUCT_SESSION_MAP_DIR`): exactly one line per file — the run id of that session's **active prompt turn**; written when the turn's run comes up, released when it finalizes; between turns the session has no mapping; atomic writes | the relay |
| Captured conversation identity (durable) | `captured_conversation_id` in the run's capture manifest: the ACP sessionId (native Codex conversation) of the prompt that caused the run, persisted by the relay at start time; survives finalization and the mapping release; the Run Ledger's attribution key (null for manual starts, probes and historical runs — never derived from telemetry) | the relay (via the start sidecar) |
| Product-runtime registration | `.artifacts/agent-observability/product-runtime.json` (§14.1) | `product-runtime register` |
| Run directory | `.artifacts/agent-runs/<run-id>/` (root overridable via `FG_OBS_RUNS_DIR`) | `agent-observability` |
| Verification summary | `.artifacts/agent-runs/<run-id>/verify-<profile>.json` with `agentRunId` | `agent-verify --summary-json` |

Active-turn resolution (the agent's view):

1. `CODEX_SESSION_ID` → mapping file → the exact run of this session's
   active prompt turn (authoritative for the automatic path; `context
   current` and `agent-verify --summary-json` both use this tier first).
2. No mapping → exactly one live product capture (canonical EPERM-aware
   liveness for `agent-observability` commands; builtins-only probe for
   `agent-verify`, §8.5); multiple candidates are refused, never guessed.
3. **Explicit override**: `FG_AGENT_RUN_ID` is a manual/debug override that
   always wins. The automatic path **never exports it** (one persistent ACP
   process serves many sessions/turns); any inherited value is dropped at
   the launch boundary.

`context current` exit semantics: 10 = zero live captures; 11 = multiple
(candidates named); an explicit run id always works, including after the
run stopped. Latest/timestamp guessing is structurally impossible in the
automatic path: the mapping names exactly one run per active turn, and
`current-run`/`context current` refuse ambiguity instead of ranking
candidates.

## 19. OTel capture pipeline

**CURRENT IMPLEMENTATION.** Canonical sources:
`scripts/observability/otelcol-local.yaml`, `scripts/observability/pins.json`,
`docs/agent/trace-contract.json`, `docs/agent/OBSERVABILITY.md`.

### 19.1 Collector and endpoint

- Distribution: official `otelcol-contrib`, **version pinned** in
  `scripts/observability/pins.json` with per-platform SHA-256 checksums
  (current: `0.161.0`; darwin_arm64 / darwin_amd64 / linux_amd64). Install
  is explicit, checksum-verified, repo-local and git-ignored
  (`.artifacts/agent-observability/otelcol/<version>/`); any `otelcol` on
  PATH or `FG_OTELCOL` is used instead if present.
- Endpoint: `http://127.0.0.1:<FG_OBS_PORT, default 4318>` — **loopback
  only**; the collector binds 127.0.0.1 only and the config has no
  external endpoints.
- Pipeline: receiver `otlp` (http) → `memory_limiter` → `batch` →
  `transform` (sanitization, §20) → `file` exporters, one per signal
  (`raw/logs.jsonl`, `raw/traces.jsonl`, `raw/metrics.jsonl`), each with
  bounded rotation (`max_megabytes` 32 / `max_days` 14 / `max_backups` 10).

### 19.2 Signals actually used

**Traces + logs + metrics are all captured** (the Codex config block sets
all three exporters; `metrics_exporter` **must** be set explicitly because
Codex's default routes product metrics to an external backend — the local
block is what keeps everything on the machine). Contract-named content:
logs = Codex events (`event.name`, `conversation.id`, `model`,
`app.version`, tool results, API requests, …); traces = spans + span events
(turn timing, TTFT); metrics = token usage (`codex.turn.token_usage`,
`codex.api_request`). The full retained/dropped sets are in
`docs/agent/trace-contract.json` — do not rely on raw field names outside
that contract.

### 19.3 Sanitizer / redaction boundary

Layered, in order: (1) Codex source `log_user_prompt = false`; (2)
deterministic collector transform — `delete_key()` on a fixed set
(`user.email`, `user.account_id`, `auth.*` keys, `error.message`,
`endpoint`, `prompt`, `arguments`, `output`, `mcp_servers`, …) on log
records, spans, span events, plus a defensive metric-attribute drop set,
plus a **resource-attribute whitelist** (`service.name`, `service.version`,
`env` — everything else, including `host.name`, is dropped deterministically);
(3) regex backstop on the one retained free-text field (`originator`) for
secret-shaped values; (4) storage under git-ignored `.artifacts/`.
`log_user_prompt` stays `false`: Codex emits `codex.user_prompt` with
`prompt = "[REDACTED]"` + length counts, and the (already redacted)
`prompt` key is dropped by the collector anyway.

### 19.4 Retention, rotation, start/finalization

- Per-file rotation as above; whole-run pruning by `start` (runs older
  than `FG_OBS_RETENTION_DAYS`, default 14, are removed).
- `start` creates the run dir, seeds the manifest (initial Git state),
  collects the doctor snapshot, refuses a conflicting listener on the OTLP
  port (exit 4), and records PID/state; the collector is a normal local
  process (not a daemon; does not survive reboots).
- `stop` drains/flushes (SIGTERM), finalizes the manifest (end-of-run Git
  evidence), cleans transient PID files, never deletes trace history, and
  auto-normalizes the run into `run-ledger.json` (a normalization failure
  is reported distinctly, exit 9, and never loses the raw capture).
- Interrupted runs are safe by format: raw files are JSON lines (one
  self-contained OTLP payload per line); interruption leaves at worst a
  truncated final line, which the manifest scan skips; prior runs are
  never rewritten or deleted by later runs.

### 19.5 Collector unavailable / port occupied

- No collector binary: `start` fails exit 3; the relay fail-opens (turn
  uncaptured, bounded warning). Doctor reports `agent_observability`
  optional-unavailable.
- Port occupied: `start`/`native-probe` fail exit 4 naming the remedy (stop
  the running capture or set `FG_OBS_PORT`); a live capture the turn does
  not own is never attached to or overwritten.
- Collector dies mid-run: raw lines already flushed are preserved;
  `stop`/the relay reconcile the run (worst case `interrupted`); the
  manifest scan skips any truncated line.
  manifest scan skips any truncated line.

## 20. Privacy and security contract

**CURRENT IMPLEMENTATION.** The explicit table (canonical:
`docs/agent/OBSERVABILITY.md` "Privacy model" + `trace-contract.json`
`droppedBySanitization` / `redactionBackstop`):

| Category | Captured? | Detail |
|---|---|---|
| User prompts | **NOT captured** | `log_user_prompt = false`; Codex emits `prompt = "[REDACTED]"` + length only; the `prompt` key is dropped by the collector regardless |
| Hidden reasoning text | **NOT captured** | no 0.148.x OTel event carries it; reasoning appears only as token counts in metrics |
| Tool arguments / results (content) | **NOT captured** | `arguments`, `output` keys dropped; only bounded length counts retained (`arguments_length`, `output_length`, …) |
| Tool identity / outcome | captured (bounded metadata) | tool **name**, success, duration, `call_id`, decision (`codex.tool_decision`), sandbox outcome |
| Auth / secrets | **NOT captured; redacted as backstop** | `auth.*` keys dropped; `originator` scanned for OpenAI/Google/GitHub/Slack/AWS key shapes and JWT shapes; auth files are referenced by symlink in the probe's temp overlay (removed afterwards), never copied |
| Environment variables | **NOT captured** | no environment dumps at any layer (Codex, collector, relay, ledger, context) |
| ACP message bodies | **NOT captured** | the relay forwards bytes opaquely; it persists only bounded identifiers (session id, run id, request id, method name, stopReason) |
| Session IDs | captured (bounded identifier) | `conversation.id` — the native Codex conversation/session id; grouping key |
| Request IDs | captured (bounded identifier) | JSON-RPC ids in relay events; `attempt` correlation in telemetry |
| Model / runtime metadata | captured | `model`, `app.version`, `originator` (sanitized), `reasoning_effort`, `sandbox_policy`, `approval_policy`, `auth_mode` (metadata), API duration + HTTP status |
| Git metadata | captured (bounded) | branch, start/end HEAD, changed-file **paths** (≤500, no diff content), line totals, `commit_created` |
| Verification results | captured (bounded) | verify summary JSON (profile, result, exit codes, phases, `agentRunId`), doctor JSON |
| Resource attributes | whitelist only | `service.name`, `service.version`, `env`; everything else (host identity, sdk fields, future additions) dropped |

Privacy-sensitive logs: the **relay event log**
(`.artifacts/agent-observability/relay-events.log`) contains only the closed
bounded-identifier vocabulary of §16.3 (1000-char line bound, 256→128 KiB
rotation); the launch boundary drops any inherited `FG_AGENT_RUN_ID` and
adds only the internal recursion guard; the launch path reads and writes no
Codex auth/config. All runtime artifacts are git-ignored (`.artifacts/`),
so nothing is committed; raw traces are never committed; credentials are
never copied.

## 21. Run directory and artifact contract

**CURRENT IMPLEMENTATION.** Complete current layout (all paths relative to
the repository root; all git-ignored via `.artifacts/`):

```text
.artifacts/
  agent-runs/                          # FG_OBS_RUNS_DIR
    run-<UTC ts>/                      # one product capture (kind "capture")
      capture-manifest.json            # normalized run manifest (schema_version 1):
                                       #   run_id, kind, start_ts, end_ts, stop_status,
                                       #   repo_root, branch, starting_head, ending_head,
                                       #   codex_version (null in captures by design, §23),
                                       #   codex_acp_version, captured_conversation_id (relay-set),
                                       #   observed conversation ids, event counts
      raw/logs.jsonl                   # sanitized OTLP JSON (log records = Codex events)
      raw/traces.jsonl                 # sanitized OTLP JSON (spans + span events)
      raw/metrics.jsonl                # sanitized OTLP JSON (metrics, e.g. token usage)
      collector.log                    # collector stdout/stderr
      probe-client.log                 # (probe runs only)
      agent-doctor-start.json          # read-only doctor snapshot from `start`
      run-context.json                 # bounded structured context (schema_version 1),
                                       # when attached via `context`
      verify-<profile>.json            # agent-verify --summary-json output (agentRunId)
      annotations.json                 # explicit human annotations (schema_version 1)
      run-ledger.json                  # normalized record (schema v3; by `stop` or `ledger`)
    probe-native-<UTC ts>/             # native-probe runs (same shape; kind "probe-native")
  agent-observability/
    otelcol/<version>/otelcol          # pinned collector binary (install)
    product-runtime.json               # product-runtime registration (schema_version 1)
    session-runs/<session-id>          # one bounded run id per session file (active turn)
    relay-events.log                   # bounded relay diagnostics (1000-char lines)
```

Purpose of each artifact: manifest = the normalization boundary input for
session + git evidence; raw = the only place sanitized telemetry lives;
run-context = the explicit task/session metadata; verification + doctor
JSON = the correlated evidence the ledger consumes; annotations = explicit
post-hoc human input (raw telemetry is never rewritten); run-ledger = the
deterministic normalized output.

## 22. Run Ledger architecture

**CURRENT IMPLEMENTATION.** Canonical contract:
`docs/agent/ledger-contract.json` (schemaVersion 3); implementation:
`scripts/observability/ledger.py`; pins: `agent-observability.test.sh`.

### 22.1 Normalization boundary

```text
raw sanitized OTel (logs/traces/metrics)  — only trace-contract fields
capture-manifest.json                     — session + end-of-run Git evidence
verification evidence JSON in run dir     — agent-verify / agent-doctor output
run-context.json                          — bounded structured run context
annotations.json                          — explicit human annotations
        ↓  (deterministic, idempotent, pure function of stored evidence)
.artifacts/agent-runs/<run-id>/run-ledger.json
```

Raw evidence vs normalized ledger: raw files are the evidence; the ledger
is the only layer later analysis may consume (no raw OTel field names
outside the trace contract). Deterministic regeneration: no wall clock, no
live git state, no environment values — re-running on unchanged evidence
yields **byte-identical** output; the end-of-run Git evidence is recorded
once at capture finalize so later normalization stays reproducible.

### 22.2 Record sections (schema v3)

- `identity` — run id, observed conversation ids, the persisted captured
  conversation identity (`captured_conversation_id`; null = unknown, never
  derived), capture kind, repo root, branch, start/end ts + duration, stop
  status, start/end HEAD.
- `runtime` — `codex_version` (telemetry-attributed, §23),
  `codex_acp_version` (independent), `models`, `collector_version`,
  `originators`, `privacy_mode`, `app_versions`, and native run-config
  fields `reasoning_effort` / `sandbox_mode` / `approval_policy` (from the
  **first** `codex.conversation_starts` event, only when the native event
  carries the attribute; else null + gap).
- `git_wip` — start/end tree cleanliness, changed files (≤500, paths only,
  truncation flag), line totals, `commit_created`.
- `activity` — tool call counts (distinct `call_id` with a result),
  broad-category by-type map (shell/file/search/web/plan/interaction/other
  — raw tool names deliberately not exposed here), success/failure counts,
  API request counts, `token_usage` (with source: metrics or sse-events),
  turn count, time-to-first-tool / first-failure / final-response. Since
  v3 the primary activity / failures / token metrics are scoped to the
  captured conversation identity when it is persisted (events and token
  datapoints of other conversations never merge into them); `activity.foreign`
  carries the bounded compact aggregate of foreign telemetry (ids,
  request/tool counts, failures, token total) or is null without a captured
  identity (the `captured_conversation_unknown` gap represents that case).
  Run-level infrastructure facts (git_wip, duration, runtime versions, stop
  status, runtime.models/app_versions) are deliberately not scoped.
- `verification` — doctor snapshot, observability doctor, one entry per
  verify summary (profile, result, exit code, timing, `agent_run_id`,
  phases), and `final_gate` = the most recently started correlated summary
  (deterministic ordering); never claims RUNTIME_VERIFIED.
- `failures` — bounded identifiers (tool name / `model_api_request` /
  phase name), ref, timestamp, result; `classification` set **only** by an
  explicit annotation — an exit code or `success=false` never invents a
  semantic class.
- `human` — correction yes/no (null = no annotation exists, unknown, not
  inferred), categories, annotations (note ≤280 chars).
- `evidence_gaps` — stable sorted codes (§25).
- `context` — the four bounded fields (§24).
- `comparability` — 12 fixed boolean presence dimensions + sorted
  `missing` list (§24).

What does NOT belong in the ledger: prompt text, hidden reasoning,
auth/token values, shell stdout/stderr, source diffs, environment dumps,
raw tool arguments. Unsupported by design (recorded as unavailable, never
guessed): repeated-command count (command text is sanitized away), human
intervention from telemetry, raw command/diff content.

### 22.3 Versioning notes

v1/v2 ledger records remain valid documents and are never rewritten in
place; re-normalization is an explicit per-run command emitting a v3
record for that run's stored evidence. Captures made before v2 normalize
to v3 with null context/runtime values plus explicit gaps; captures made
before v3 (no persisted `captured_conversation_id`) normalize to v3 with
the identity null, the run-wide aggregate preserved as primary activity,
and the `captured_conversation_unknown` gap present whenever at least one
conversation was observed — nothing is guessed or back-filled. Consumers
must branch on `schema_version`: v2 is a strict field superset of v1; v3
is a strict field superset of v2 EXCEPT that, when a captured conversation
identity is present, the activity / failures / token-usage fields changed
meaning (captured turn only; foreign telemetry moves to `activity.foreign`).

## 23. Product Codex version attribution

**CURRENT IMPLEMENTATION** (post-`8f2deae`; canonical: the ledger contract
`runtime.codex_version` entry + `ledger.py`).

The corrected rule, stated explicitly:

```text
controller codex version  ≠  captured product Codex version
```

- The controller/standalone `codex` on `PATH` (what the developer shell or
  the collector process sees) is **informational only** — it may be a
  different Codex than the one that executed the captured turn.
- `runtime.codex_version` is derived **exclusively from the telemetry
  `app.version` attribute** the product Codex process itself emitted (the
  values preserved in `runtime.app_versions`):
  - exactly **one** distinct non-empty value → that value (no prefixing or
    formatting beyond the emitted value) → **resolved**;
  - **zero** distinct values → `null` + gap `codex_version_unresolved`;
  - **several** distinct values → `null` + gap `codex_version_unresolved`
    — **without guessing**; all observed values remain preserved in
    `app_versions`.
- Capture manifests **no longer seed** a codex version from the collector
  shell at all (the manifest `codex_version` stays `null` in captures;
  only `native-probe` records the exact binary the probe ran, because the
  probe's home/path are part of its own evidence).
- `codex_acp_version` remains an independent field (adapter identity, not
  Codex).

## 24. Run context and comparability

**CURRENT IMPLEMENTATION.** Canonical: `run-context.json` contract
(`scripts/observability/runcontext.py` + ledger contract `context`).

The four dimensions:

| Field | Type | Notes |
|---|---|---|
| `task_type` | closed enum: `Bug` \| `Vertical Slice` \| `Domain` \| `Stabilization` \| `Documentation` | matches the repository's orchestration contract; null until explicitly attached |
| `session_mode` | closed enum: `CURRENT` \| `NEW` | null until explicitly attached |
| `task_key` | optional bounded slug (1–128 chars `[A-Za-z0-9._-]`) | explicitly pairs runs of the same logical task for future controlled comparisons; never invented |
| `harness_variant` | optional bounded slug | labels explicit future A/B harness runs |

Attachment: `./scripts/agent-observability context current|<run-id>
--task-type T --session M [--task-key K] [--harness-variant H]`. Updates
are partial and idempotent (same values → byte-identical no-op; fields not
passed are preserved). Arbitrary prompt/chat text cannot be stored in any
field — malformed or prompt-shaped values fail closed (exit 2 at write,
exit 7 on a corrupted stored file). Nothing is inferred: task type is
never derived from the prompt; session mode never from the transcript.

Missing dimensions stay **explicit**: `comparability.dimensions` is a set
of 12 fixed booleans (model, reasoning_effort, codex_version,
codex_acp_version, sandbox_mode, approval_policy, task_type, session_mode,
git_starting_revision, verification_evidence, doctor_evidence,
harness_variant) that are TRUE only when the dimension's evidence exists,
plus a sorted `missing` list. It answers only *whether evidence exists* —
it is never a quality score and never ranks runs. Missing stays missing
rather than inferred because inference would silently destroy cohorting
integrity in later cross-run analysis.

## 25. Evidence gaps

**CURRENT IMPLEMENTATION.** The stable gap codes from `ledger.py`
(sorted in the record):

| Code | Absence means | Expected / optional / blocking | Effect on comparability / acceptance |
|---|---|---|---|
| `no_telemetry` | no usable raw telemetry events in the run | blocking for behavior analysis (the run has no agent telemetry) | most dimensions unresolved; the run is nearly non-comparable |
| `codex_version_unresolved` | zero or several distinct `app.version` values observed (the current Codex-version behavior, §23) | optional-but-important; explicit, never guessed | `codex_version` comparability dimension false |
| `no_run_context` | no `run-context.json` (or pre-v2 capture) | optional | `task_type` / `session_mode` / `harness_variant` dimensions false |
| `no_metrics_file` | no `raw/metrics.jsonl` | optional | metrics-sourced `token_usage` unavailable (SSE fallback may still fill it) |
| `token_usage_unavailable` | no token counts from any source | optional | `activity.token_usage` null |
| `no_end_git_evidence` | no end-of-run Git state (captures finalized before the field existed, or failed finalize) | optional | ending tree/HEAD/commit_created null |
| `no_verification_evidence` | no verify summary in the run dir | expected for runs without verification | `verification_evidence` dimension false; `final_gate` null |
| `no_doctor_evidence` | no doctor JSON in the run dir | optional (the `start` snapshot normally provides it) | `doctor_evidence` dimension false |
| `no_annotations` | no human annotations recorded | optional (unknown, not inferred) | `human.correction_occurred` null |
| `captured_conversation_unknown` | no persisted captured conversation identity while telemetry from at least one conversation is present (pre-v3 capture, manual start, probe) | optional-but-important; explicit, never guessed | primary activity is the run-wide aggregate and MUST NOT be read as the captured turn's activity; `activity.foreign` is null |

No other gap names exist in the implementation; do not invent new ones
without a contract change.

## 26. Observability command reference

**CURRENT IMPLEMENTATION.** Exact current surface (full semantics in §6.1
and `docs/agent/OBSERVABILITY.md`):

| Command | Intended for | Key exit semantics |
|---|---|---|
| `status [--json]` | automatic normal operation (agents poll it) + manual diagnostics | 0 read-only success |
| `start [--json]` | manual fallback + relay sidecar (automatic path) | 1 generic; 3 collector missing; 4 port conflict; `--json` single-write `started`/`already_running` |
| `stop [--stop-status graceful\|interrupted]` | manual fallback + relay sidecar | 0; 9 ledger normalization failure (raw preserved) |
| `doctor [--json]` | manual diagnostics (pipeline acceptance) | AVAILABLE / NOT_CONFIGURED / BLOCKED / BROKEN |
| `config` | one-time manual setup (prints the exact `[otel]` block for the product home) | refuses actionable destination when product identity unknown/corrupt |
| `install` | host-level one-time collector install (opt-in) | 0; network failure nonzero |
| `native-probe` | native probe/testing (pipeline acceptance, NOT product-session adoption proof) | 1; 4 port occupied; 5 no valid / ambiguous standalone Codex home |
| `ledger [run-id] [--json]` | automatic (run by `stop`) + manual diagnostics | 0; 2 usage; 6 run dir missing; 7 manifest missing/malformed; 8 verification attribution mismatch |
| `annotate <run-id> …` | manual diagnostics (post-hoc human input) | 0; 2 usage |
| `context current\|<run-id> …` | automatic normal operation (agent attaches its given Task type + Session once per run) | 0; 2 validation; 7 corrupt stored; 10 zero live captures; 11 multiple |
| `product-runtime register\|show` | one-time setup from inside a product-agent session (also done idempotently by `context`) | 0; 5 `CODEX_HOME` unset (register); 7 corrupt (show) |
| `current-run` | manual correlation helper (feeds reliable explicit `FG_AGENT_RUN_ID`) | 0; 10 zero; 11 multiple |
| `current-run` | manual correlation helper (feeds reliable explicit `FG_AGENT_RUN_ID`) | 0; 10 zero; 11 multiple |

---

## 27. Harness contract tests

**CURRENT IMPLEMENTATION.** The harness-specific contract suites (none of
them is executed by any `agent-verify` profile or by CI; they are run
directly when touching the harness — `bash scripts/tests/<suite>`).

| Suite | Contract protected | Real subprocesses / collector? | Important failure classes | Product behavior? | Classification |
|---|---|---|---|---|---|
| `scripts/tests/agent-doctor.test.sh` | doctor output formats (human + JSON schema, stable capability order, summary consistency), exit codes, non-mutation, no secrets in output, simulated blockers (restricted PATH = missing runtimes; empty `PLAYWRIGHT_BROWSERS_PATH` = missing browser), optional-capability gating (`FG_DOCTOR_REQUIRE_OBSERVABILITY`), launch-error classification + cause sanitization, read-only contract markers in source | runs the real doctor against restricted environments; no collector | format drift, exit-code drift, mutation, secret leakage, optional-cap leakage into the result | none (harness only) | CORE mechanism, CONFIG probes |
| `scripts/tests/agent-verify.test.sh` | usage, `plan` mode (read-only, rejects `--summary-json`), the `--summary-json` contract: schemaVersion-1 shape, exact announced commands, stable phase order, fail-fast (process rc == JSON exitCode, one failed phase, later phases `not_run`), no file without the flag, identical human output with/without flag (timing normalized), target validation (missing/unwritable/invalid dir rejected before any phase; no parent creation; relative paths vs caller CWD), no secrets/env in summary, no leftover temp files | **no real profile executes** — phase tools replaced by deterministic PATH shims with scripted exit codes (same restricted-PATH convention as the doctor tests) | summary schema drift, fail-fast contract drift, mutation/leakage | none | CORE |
| `scripts/tests/agent-observability.test.sh` | usage/exit codes; `config` output contract (loopback endpoints, `log_user_prompt=false`, repo-config rationale); gitignore coverage of all runtime artifact paths; `status` read-only + deterministic; collector config template (sanitization statements, loopback-only); `pins.json` integrity; `manifest.py` seed/finalize/summary + interrupted-run safety; probe-client usage contract; `CODEX_HOME`/`CODEX_PATH` resolution (discovery, explicit authority, invalid/ambiguous fail-closed); ACP probe-client schema contract vs codex-acp 1.7.0 (fake-agent fixture); collector-dependent e2e (start/stop idempotency + fake-secret sanitization + doctor) — executed only when a collector is present and none is running, else SKIPPED; Run Ledger: deterministic normalization of a synthetic capture (fixture OTel + real manifest seed/finalize in a temp git repo), idempotency, activity/timing/token metrics, git/WIP evidence, failures without invented classifications, explicit verification correlation (agentRunId match/mismatch), doctor evidence, annotations, privacy (dropped-key values never reach the ledger), dedup identity (distinct paired records sharing the correlation tuple are kept — incl. the 0.148.0 paired `response.completed` with/without token counters — while byte-equivalent copies collapse and the pair's counters reach token accounting), captured-conversation attribution (v3 ledger: clean single-conversation run unchanged; captured + foreign conversation → primary metrics = captured only with the foreign telemetry explicitly reported; multiple foreign conversations deterministic; missing identity → run-wide aggregate + `captured_conversation_unknown` gap; historical-incident reconstruction), manifest `captured_conversation_id` persistence (seed, finalize survival, invalid value fails safe to null), missing telemetry → null + gaps, malformed manifest → clear failure | mixed: static + Python unit-level + one real-collector e2e section (conditional) | schema/pin drift, privacy regression, determinism break, correlation mismatch, dedup over-collapse (counter-bearing records dropped), liveness semantic regression | none (synthetic captures only) | CORE |
| `scripts/tests/agent-product-launch.test.sh` | the per-**prompt-turn** lifecycle end-to-end: session open starts NO run; prompt A → run A (+ active-turn mapping); response A → graceful finalization (end Git evidence, ledger, mapping released, collector stopped) with the session STAYING ALIVE; prompt B → distinct run B; exact request-id correlation (forged wrong-id never finalizes; late duplicate bounded no-op); close during active turn → interrupted; duplicate/unknown closes harmless; no run for session-less process / session without prompt; prompt content never persisted; fragmented stream stays valid ACP; crash/signal fallbacks (crash mid-prompt → interrupted, no orphan collector, exit status kept; SIGTERM mid-turn → 143); concurrency (foreign live capture → fail open; after it ends the same session's next prompt is captured); run identity (inherited stale `FG_AGENT_RUN_ID` dropped; mapping resolves the turn's run including over a newer live run; explicit override still wins); verification correlation (summary attributed to the ACTIVE TURN's run via the mapping; finalization ledger consumes it); fail-open (broken collector → uncaptured, stream intact, bounded warning); re-opens (`session/resume` + `session/load` as fresh ROOT sessions, `session/fork` response id) — every prompt turn gets its own run; mapping-write failure contract; NDJSON wire on real newline-delimited traffic; opt-out `FG_AGENT_OBSERVABILITY=0`; doctor-snapshot knob; `start --json` contract; captured conversation identity persisted by the relay into the run manifest at start (`captured_conversation_id` — present after finalization and mapping release, echoed into the generated ledger identity); one-time install (backup/trampoline/config, idempotency, status, trampoline end-to-end with a real ACP session through the installed trampoline, fallback when the wrapper is missing, uninstall) | **yes** — real subprocesses: scenario driver + fake long-lived ACP server + **real collector** in temp dirs, plus the byte-level framer units (no collector needed) | lifecycle-boundary regression (wrong finalization trigger), correlation regression (id guessing), privacy leakage, install/rollback break, wire-format regression | none (fake ACP server stands in for the product launcher) | CORE mechanism + HOST INTEGRATION contract |
| `scripts/tests/core-workflow.test.sh` | `.github/workflows/core.yml` security/contract invariants: triggers exactly PR(main)+push(main)+dispatch; `permissions: contents: read`; single job on pinned ubuntu (no `ubuntu-latest`) with bounded timeout; concurrency cancels PR superseded runs only; all `uses:` pinned to 40-char SHAs; `postgres:16` health-checked service on 5432; reproducible setup (`npm ci`, `uv sync --frozen`, **no** Playwright browser); exactly one canonical `agent-verify … core` invocation with the `--summary-json` target; upload conditions `!cancelled()` | no (static file assertions; optional actionlint if installed) | trigger/permission drift, unpinned action, non-canonical gate invocation, browser leak into core | none | CONFIG (FG CI wiring) |
| `scripts/tests/e2e-workflow.test.sh` | same for `e2e.yml`, plus: Playwright chromium-only install; **no** direct `npm run test:e2e` / `playwright test` gate call — the only invocation is the canonical `agent-verify e2e` with `--summary-json`; `FG_ALLOW_E2E_RESET` appears **exactly once**, on the canonical gate line; exact upload matrix (summary `!cancelled()`; failure artifacts `failure() && !cancelled()`) | no (static) | consent flag duplication/missing, non-canonical gate, upload matrix drift | none | CONFIG |

Fixtures (`scripts/tests/fixtures/`):

| Fixture | Role |
|---|---|
| `acp-fake-server.py` | long-lived fake ACP server speaking real NDJSON JSON-RPC (initialize, session/new, load, resume, fork, prompt, close, delete) — stands in for the product launcher in lifecycle tests |
| `acp-scenario-driver.py` | drives the repo wrapper (fake server as delegate) through real ACP traffic and asserts the per-prompt-turn lifecycle on the filesystem |
| `fake-acp-adapter.mjs` | deterministic fake ACP agent mirroring the codex-acp 1.7.0 request contract (validates `session/prompt` params against the exact 1.7.0 schema; `-32602` shapes) for probe-client contract tests |
| `ndjson-framer-units.py` | byte-level unit tests of the relay's NDJSON wire observer (fragmentation, multi-line reads, per-line skip boundary, CRLF, blank lines, long lines) — runs without a collector |

Counts are transient (a "last verified snapshot" at `8f2deae`: six suites;
do not treat any count as an architectural invariant).

## 28. Automatic vs compliance-based enforcement

**CURRENT IMPLEMENTATION.** Matrix of who enforces what. This is the
residual-risk map of the harness.

| Rule / behavior | Machine enforced | Automatically injected | Script enforced | CI enforced | Behaviorally tested | Instruction / compliance only |
|---|---|---|---|---|---|---|
| Root `AGENTS.md` discovery | — | **yes** (agent runtime injects it) | — | — | — | (the *content* still must be followed) |
| Scoped `AGENTS.md` reads | — | — | — | — | — | **yes** (PRECHECK orders it; nothing checks the read) |
| Doc routing (smallest relevant set) | — | — | — | — | — | **yes** |
| Doctor execution | — | — | doctor itself is read-only, exit-coded, contract-tested | — | yes (doctor suite) | **when** to run it is compliance |
| Verification ladder width (targeted→broad) | — | — | profiles refuse/allow per contract | the *final* gates run the canonical profiles | yes (verify suite) | **choosing** the width per slice is compliance |
| Repo hygiene (`git diff HEAD --check`) | — | — | **yes** — first phase of `quick`/`core` | **yes** (inside core) | yes | — |
| Destructive E2E reset consent | — | — | **yes** — double gate in `reset_e2e` (settings module + exact flag) and `agent-verify` pre-refusal | **yes** (flag set exactly once, pinned) | yes (`test_reset_e2e.py`, verify suite) | — |
| No implicit installs / retries / parallelism in verify | — | — | **yes** (script contract) | — | yes | — |
| Failure classification | — | — | — | — | — | **yes** (the four classes bind only via instructions + ledger annotation) |
| Evidence statuses / completion table | — | — | — | — | — | **yes** (vocabulary is canonical; claims are prose) |
| Summary JSON accuracy | — | — | **yes** (real exit codes, fail-fast contract) | artifacts | yes | reading it honestly is compliance |
| Commit discipline (stage exact files, inspect staged diff, clean tree) | — | — | `git diff HEAD --check` covers whitespace only | — | — | **yes** |
| Branch workflow (slice branch, FF merge, delete after CI) | — | — | — | gates exist (advisory; no branch protection) | — | **yes** |
| Session choice (CURRENT vs NEW) | — | — | — | — | — | **yes** |
| Scope control (no new deps/frameworks/…) | — | — | — | — | — | **yes** (lockfiles/migrations drift checks *detect* drift but do not prevent decisions) |
| Observability fail-open | — | — | **yes** (relay/launch contract: product path always works) | — | yes (product-launch suite) | — |
| Privacy (no prompt/secret persistence) | — | — | **yes** (sanitization, bounded fields, gitignore) | — | yes (fake-secret tests) | — |
| `.artifacts/` never committed | **yes** (gitignore) | — | — | — | yes (observability suite checks gitignore coverage) | — |

Reading the table: the *mechanics* (what runs, what refuses, what is
written) are machine- and script-enforced and behaviorally pinned; the
*judgments* (which docs to read, which width to run, how to classify, how
to report, when to start a new session) are compliance-only. That split is
deliberate (it keeps the harness light), and it is the main residual risk:
a non-compliant agent can still run the right commands while mis-reporting
them. The Evidence contract + the completion table are the mitigations.
them. The Evidence contract + the completion table are the mitigations.

---

# PORTABILITY — COMPLETE SPECIFICATION

Sections 29–38. Every forward-looking statement in this part is
**PORTABILITY TARGET / RECOMMENDED FUTURE ARCHITECTURE** unless explicitly
marked otherwise.

## 29. Portability classification

**CURRENT IMPLEMENTATION** assessment of each current component. Classes:

- **CORE** — reusable mechanism whose semantics should be identical
  across repositories.
- **CONFIG** — repository-specific values consumed by generic mechanisms.
- **REPO KNOWLEDGE** — product/domain-specific truth.
- **HOST INTEGRATION** — machine-level setup that should eventually be
  shared across repositories.

| Component | Path | Class | Notes |
|---|---|---|---|
| Evidence model (5 statuses, 4 classes, budgets, completion table) | `docs/agent/WORKFLOW.md` | CORE | stack-independent policy text |
| Runtime contract / per-run metadata fields | `docs/agent/RUNTIME.md` | CORE | shared with Eval |
| Verify framework (profiles, plan, fail-fast, summary JSON, correlation tiers) | `scripts/agent-verify.sh` | CORE mechanism | the *phase commands* are CONFIG (see row below) |
| Verification profiles' concrete commands | same file | CONFIG | `npm run …`, `uv run …`, `fg_e2e` consent |
| Doctor framework (capability model, statuses, gates, JSON, exit codes, read-only contract) | `scripts/agent-doctor.sh` | CORE mechanism | the 16 probes are CONFIG |
| Doctor probes (node/uv/django/playwright/postgres specifics) | same file | CONFIG | per-stack values (Node ≥ 24, Python ≥ 3.12, `fg_e2e`, port 5432) |
| ACP lifecycle relay (NDJSON, prompt-turn boundary, mapping, fail-open) | `scripts/observability/acp-lifecycle-relay.py` | CORE | generic ACP mechanism; repo root derived from its own path |
| Liveness semantic (EPERM alive) | `scripts/observability/liveness.py` | CORE | portable by design |
| Manifest + raw-scan | `scripts/observability/manifest.py` | CORE | git evidence + OTLP scan are generic |
| Ledger normalizer + schema | `scripts/observability/ledger.py`, `docs/agent/ledger-contract.json` | CORE mechanism | record name `fg-agent-run-ledger` is a CONFIG string; broad tool-category map is CORE-with-extensions |
| Trace contract | `docs/agent/trace-contract.json` | CORE shape + VERSIONED CONFIG | event/attribute names are Codex-version-specific (re-verify after Codex upgrades) |
| OTel pipeline (collector config template, pins, rotation, loopback) | `scripts/observability/otelcol-local.yaml`, `pins.json` | CORE mechanism | port 4318 + retention defaults are CONFIG knobs |
| Run context (bounded enums/slugs) | `scripts/observability/runcontext.py` | CORE mechanism | the task-type enum values are REPO KNOWLEDGE (they mirror this repo's orchestration contract) |
| Product-runtime registration | `scripts/observability/productruntime.py` | CORE | identity bridge; per-repo registration file |
| Control surface | `scripts/agent-observability` | CORE mechanism | env-var names `FG_*` are a CONFIG/naming concern |
| Host trampoline + install model | `scripts/agent-product-launch`, `~/.local/bin`, `~/.local/share/lucid-codex-acp/` | HOST INTEGRATION | currently repo-pointing (one repo per host) — §15.4 |
| Repository instruction files | `AGENTS.md`, `apps/*/AGENTS.md` | REPO KNOWLEDGE | the *shape* (root + scoped + ladders) is CORE guidance |
| Documentation map + checkpoint | `docs/README.md`, `docs/CURRENT_STATE.md` | REPO KNOWLEDGE | shape is CORE guidance |
| Domain/architecture/product docs | `docs/domain/*`, `docs/architecture.md`, `docs/product.md` | REPO KNOWLEDGE | not portable, not needed by the harness core |
| E2E state (reset/seed/settings_e2e) | `reset_e2e`, `seed_dev`, `seed_e2e_scope`, `apps/api/config/settings_e2e.py`, `playwright.config.ts` | CONFIG + REPO KNOWLEDGE | pattern (isolated schema + deterministic seed + choke-point consent) is CORE |
| CI workflows | `.github/workflows/*.yml` | CONFIG | wiring the same core patterns to a new repo's stack |
| Harness contract tests | `scripts/tests/*` | CORE mechanism + CONFIG assertions | per-repo values (postgres:16, consent flag) must follow the repo |
| Artifact layout (`.artifacts/…`) | `.gitignore`, all observability scripts | CORE convention | paths relative to repo root |
| Seeds / test users / fixture data | `seed_dev`, `e2e/` specs, helpers | REPO KNOWLEDGE | product-shaped data |
| Eval packages | `evals/` | REPO KNOWLEDGE (Eval) | separate system, §41 |
| Root runbook (setup/dev) | `README.md` | REPO KNOWLEDGE | human-facing, language-specific |

## 30. Current portability problems

**CURRENT IMPLEMENTATION** (inspected couplings, classified). None of this
is fixed by this document.

| # | Coupling | Where | Classification |
|---|---|---|---|
| 1 | `FG_`-prefixed environment variables throughout (`FG_ALLOW_E2E_RESET`, `FG_OBS_PORT`, `FG_OBS_RUNS_DIR`, `FG_AGENT_RUN_ID`, `FG_AGENT_OBSERVABILITY`, `FG_DOCTOR_REQUIRE_OBSERVABILITY`, `FG_PRODUCT_*`, …) | all scripts | **should parameterize** (naming is harmless single-repo, but a multi-repo core needs a neutral namespace or per-repo config) |
| 2 | Repo-absolute paths embedded in the **host trampoline + config** (the trampoline execs *this repo's* `scripts/agent-product-launch`; the config stores this repo's root) | `agent-product-launch` install | **must extract** (host-global dispatcher instead — §15.4, §31) |
| 3 | Trampoline marker string contains the repo name (`# BEGIN fg-meeting-traum agent-product-launch trampoline`) | `agent-product-launch` | **should parameterize** (repo-identity parameter) |
| 4 | Doctor probes assume Node ≥ 24 / npm workspaces / uv / `apps/api/.venv` / Django+psycopg / Playwright Chromium / PostgreSQL | `agent-doctor.sh` | **should parameterize** (probe list + versions as per-repo config) |
| 5 | Verify phase commands hard-code `npm run …`, `uv run python manage.py …`, `git diff HEAD --check` | `agent-verify.sh` | **should parameterize** (profile = named phases with per-repo commands) |
| 6 | E2E consent + reset are tied to Django (`DJANGO_SETTINGS_MODULE=config.settings_e2e`, `fg_e2e` schema, `seed_dev`/`seed_e2e_scope`) | `reset_e2e.py`, `playwright.config.ts` | **acceptable repo-local behavior** (the *pattern* is portable; the implementation is per-repo) |
| 7 | Hard-coded ports: 4318 (OTLP), 5432 (PG doctor probe + CI), 8010/4173 (E2E dev servers) | scripts, playwright config | **should parameterize** (config knobs; already env-overridable where they matter: `FG_OBS_PORT`, `POSTGRES_*`) |
| 8 | Artifact paths under repo-local `.artifacts/` (runs, collector, mappings, relay log) | all observability code | **acceptable repo-local behavior** (per-repo state is correct; the *layout* should stay a shared convention) |
| 9 | Ledger record name `fg-agent-run-ledger`; task-type enum mirrors this repo's orchestration contract | `ledger.py`, `runcontext.py` | **should parameterize** (record name per repo; enum per repo knowledge) |
| 10 | Product `CODEX_HOME` registration is per-repo (one `product-runtime.json` per repo) though the product home is a host fact | `productruntime.py` | **host-global concern** (one host-level registration; repos reference it) |
| 11 | Tests assume the repo layout (`apps/api/.venv`, `postgres:16`, `fg_e2e`, consent flag, specific script names) | `scripts/tests/*` | **acceptable repo-local behavior** (contract tests must follow the repo they test) |
| 12 | `OTel` capture contract names are Codex-0.148.x-specific (event/attribute names derived from `codex-rs/otel`) | `trace-contract.json` | **must re-verify on upgrade** (already documented; versioned contract) |
| 13 | `agent-verify` auto-correlation tier 2 is builtins-only and same-identity (EPERM treated as absent) | `agent-verify.sh` | **acceptable repo-local behavior** (deliberate decoupling; the reliable path is `current-run` + explicit id) |
| 14 | One loopback endpoint / one capture at a time | observability architecture | **KNOWN LIMITATION** (documented; multi-turn routing out of scope until needed) |

## 31. Recommended multi-repository target architecture

**PORTABILITY TARGET / RECOMMENDED FUTURE ARCHITECTURE.** Not implemented.

Intended ownership boundary:

```text
Global / shared Harness Core (versioned, ONE copy per machine or per
  org-shared install)
  - evidence model + completion format (policy text)
  - verify framework (profiles/plan/summary/correlation)
  - doctor framework (capability model, statuses, gates, JSON)
  - observability machinery (relay, liveness, manifest, ledger,
    run-context, OTel template, pins, control surface)
  - shared contract tests (the framework's own suite)
        |
        v
Repository adapter (per repo, small + reviewable)
  - .agent-harness.toml (or equivalent): identity, commands, profiles,
    capability probes, services, browser/E2E, state/reset, docs routing,
    artifact location, optional observability overrides   (§32)
  - thin wrappers: repo's scripts/agent-verify etc. = "core + my config"
        |
        v
Repository knowledge (per repo, NOT shared)
  - AGENTS.md hierarchy, CURRENT_STATE, domain/architecture docs,
    seeds, e2e specs, CI wiring

ONE host-level Lucid/ACP integration (per machine, NOT per repo)
  - global trampoline at the launcher path
  - dispatch: resolve the active repository from the ACP client's working
    directory (or an explicit mapping) -> that repo's adapter/config
  - correlation: session/run mappings + product-runtime registration are
    host-global; run dirs stay per-repo
        |
        v
Each repository observes its own turns into its own .artifacts/
```

Conceptual structure (architectural guidance only — do not implement in a
documentation task):

```text
agent-harness/                      # shared core (its own repo / package)
  core/                             # evidence policy, session/slice policy
  observability/                    # relay, liveness, manifest, ledger,
                                    # run-context, product-runtime, otel
  verification/                     # verify framework (phase engine, plan,
                                    # summary, correlation tiers)
  doctor/                           # capability engine + probe adapters
  schemas/                          # trace/ledger/summary contract JSON
  tests/                            # framework contract tests

repo/
  AGENTS.md                         # repo knowledge (routing, ladders)
  .agent-harness.toml               # the adapter config (§32)
  docs/                             # repo knowledge
  scripts/thin-wrappers/            # agent-verify/agent-doctor = core + config
```

Why: one host integration (no clobbering), one versioned core (no divergent
forks — the #1 risk of per-repo copies), per-repo knowledge stays where it
belongs, and a new repo's onboarding becomes "adapter + knowledge +
conformance" (§34–§36).

## 32. Configuration contract for a future portable harness

**PORTABILITY TARGET / RECOMMENDED FUTURE ARCHITECTURE — PROPOSED / NOT
IMPLEMENTED.** No `.agent-harness.toml` exists today; creating one is
explicitly out of scope for this task.

Format choice: **TOML** (`.agent-harness.toml` at the repository root).
Rationale: the backend toolchain (uv/pyproject) already uses TOML, it is
commentable (repo knowledge needs comments), has tables (natural fit for
profiles/probes), and is consumable by both Python (stdlib-adjacent, one
small dependency in the core) and bash tooling (via a tiny generator). JSON
was rejected for a human-edited config (no comments, drift-prone by hand);
YAML was rejected (indentation sensitivity in machine-generated files).

Proposed concepts (keep product/domain knowledge OUT of this file):

```toml
# PROPOSED / NOT IMPLEMENTED — illustrative schema, not a contract
schema = 1

[repository]
name = "repo-2"                     # identity (also for ledger record name, trampoline marker)

[commands]
typecheck = "npm run typecheck"
lint = "npm run lint"
# ... one entry per verify phase the repo contributes

[profiles]
quick = ["repo_hygiene", "typecheck", "lint", "backend_check"]
core = ["repo_hygiene", "frontend", "backend"]

[capabilities]                      # doctor probe declarations
node = { kind = "runtime", min_version = "24" }
postgres = { kind = "service", host_env = "POSTGRES_HOST", port_env = "POSTGRES_PORT" }
chromium = { kind = "browser", launch_check = true }

[services]
database = { default = "localhost:5432", env = ["POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"] }

[e2e]
browser = "chromium"
reset_command = "…"                 # the repo's destructive-reset choke point
consent_env = "ALLOW_E2E_RESET"     # repo's consent variable
state_scope = "schema:fg_e2e"       # what the reset may touch (documentation + doctor honesty)

[docs]
root_instructions = "AGENTS.md"
scoped_instructions = ["apps/api/AGENTS.md", "apps/web/AGENTS.md"]
map = "docs/README.md"
checkpoint = "docs/CURRENT_STATE.md"

[artifacts]
root = ".artifacts"

[observability]                     # optional overrides only
otel_port = 4318
retention_days = 14
task_types = ["Bug", "Vertical Slice", "Domain", "Stabilization", "Documentation"]
```

Rules: the core owns semantics (statuses, correlation, privacy); the config
owns values (commands, versions, ports, env names, doc paths, enums).
Anything that would encode product/domain truth (seed data, invariants,
features) stays in repo knowledge and is forbidden here.

## 33. Minimum viable transfer to Repository 2

**PORTABILITY TARGET** (practical procedure, pre-extraction). Goal: adopt
the *current* harness in a second repository with minimal effort and
without creating two permanently divergent forks. This is the procedure to
use **today**, before the shared Core exists.

### Copy / adapt now

1. **Verify + doctor framework**: copy `scripts/agent-verify.sh` and
   `scripts/agent-doctor.sh` into Repo 2; replace the phase commands and
   probe list with Repo 2's stack (same structure, same plan/summary/
   consent mechanics). Keep the phase engine, fail-fast, `plan`,
   `--summary-json`, mutation classes, and exit-code contracts unchanged.
2. **Evidence + workflow policy**: copy `docs/agent/WORKFLOW.md` (adapt
   only the CI-gate and command names) and create Repo 2's `AGENTS.md`
   using this repo's *structure* (purpose, repo map, doc routing, context
   discipline, core rules, working method, validation, scope control, stop
   condition) with Repo 2's content.
3. **Contract tests**: copy `scripts/tests/agent-verify.test.sh` and
   `agent-doctor.test.sh`, adapt the asserted commands/capabilities.
4. **Documentation skeleton**: `docs/README.md` (map + source-of-truth
   ownership), a `docs/CURRENT_STATE.md`, and an `docs/agent/` directory.

### Reuse without modification

- `docs/agent/WORKFLOW.md`'s Evidence contract section verbatim (statuses,
  classes, budgets, completion table) — it is stack-independent.
- The observability mechanism **files** as-is where a shared home is not
  available yet: `scripts/observability/*` can be copied verbatim (they are
  repo-root-relative and stack-independent), but see "do not copy blindly"
  for the host integration.
- `docs/agent/RUNTIME.md` (adapt harness identity if the harness differs).

### Rewrite for Repo 2

- The doctor *probe bodies* (runtimes/deps/services specific to Repo 2's
  stack) and the verify *phase commands*.
- The E2E state infrastructure (Repo 2's own reset/seed/settings + consent
  choke point in its own framework — the double-consent *pattern* applies
  even if the implementation language differs).
- The CI workflows (Repo 2's runners/services) + their static contract
  tests.
- `AGENTS.md` content (all of it is repo knowledge).
- Seeds, specs, fixtures, runbook.

### Do NOT copy blindly

- **The host integration** (`agent-product-launch install`): Repo 2's
  install would **clobber Repo 1's trampoline** (one launcher path per
  host). Until the shared dispatcher (§31) exists: install exactly ONE
  repo's integration per host (the repo you currently work in), and flip
  it deliberately when switching — or disable product-session
  observability in the inactive repo. Never run two installs.
- `product-runtime.json` semantics: the product `CODEX_HOME` is a host
  fact; re-registering per repo is fine (per-repo file) but the underlying
  home is one per host — do not treat divergent registrations as divergent
  product runtimes.
- `trace-contract.json`: it is Codex-version-specific, not repo-specific —
  if Repo 2 uses the same Codex line, reuse; re-verify after any Codex
  upgrade (both repos).
- `evals/`: never copy Eval state; Eval is per-repo historical-state
  infrastructure (§41).
- Any `.artifacts/` content (runtime state is never portable).

### Host setup that must not be installed twice

- The Lucid/ACP trampoline + delegate + config (`~/.local/bin/
  lucid-codex-acp`, `~/.local/share/lucid-codex-acp/`).
- The product `CODEX_HOME` `[otel]` configuration (one product home per
  host; the endpoint/port must match whichever repo's collector will run).
- The collector install can stay per-repo (`.artifacts/…` is repo-local)
  but only one loopback port can be held at a time — coordinate via
  `FG_OBS_PORT` if both repos are active on one machine.

Anti-drift rule for the forked-copy phase: treat Repo 2's copies as
**frozen mirrors** — any fix that applies to the *mechanism* (not repo
values) must be applied to both copies the same day, and logged in both
repos' `docs/agent/` as a cross-repo harness change, until the shared Core
absorbs them.

## 34. Desired steady-state onboarding for Repository N

**PORTABILITY TARGET / RECOMMENDED FUTURE ARCHITECTURE.** Ideal future
workflow once the shared Core exists (commands marked `(future)` do not
exist today):

```text
1. install/update Harness Core once (machine-level)      (future:
      agent-harness install|update)
2. one-time host integration (global dispatcher)         (future:
      agent-harness host install)
3. initialize the repository adapter                      (future:
      agent-harness init <repo>)   -> writes .agent-harness.toml + thin
                                       wrappers + contract-test skeleton
4. fill project commands / capabilities / docs routing    (human+agent)
5. create canonical repo docs (AGENTS hierarchy, map,
   CURRENT_STATE, domain docs)                            (repo knowledge)
6. run conformance                                        (future:
      agent-harness conformance <repo>)  -> §36 acceptance suite
7. run a smoke agent (fresh session, one bounded task,
   completion report checked against the Evidence contract)
8. repository becomes Harness-ready
```

What the future command names would mean:

- `agent-harness init` — scaffold the adapter + thin wrappers + test
  skeleton from the Core, without touching repo knowledge.
- `agent-harness doctor` — Core doctor engine + this repo's capability
  declarations (what `scripts/agent-doctor.sh` is today, config-driven).
- `agent-harness verify` — Core verify engine + this repo's profiles
  (what `scripts/agent-verify.sh` is today, config-driven).
- `agent-harness conformance` — the §36 acceptance test: does a fresh
  agent discover instructions, find context, run doctor, identify
  targeted vs final verification, classify failures, and produce the
  required evidence?

## 35. New-repository onboarding checklist

**PORTABILITY TARGET** (reusable procedure; applies to Repo 2 today via the
§33 mapping). Ordered — later steps assume earlier ones.

1. **Repository inventory** — languages, frameworks, monorepo layout,
   entrypoints, generated dirs to exclude.
2. **Language/framework detection + versions** — the exact runtime
   contracts (e.g. Node ≥ 24, Python ≥ 3.12) and where they are pinned
   (lockfiles/engines) — these become doctor probe values.
3. **Package manager / lockfiles** — install commands that are
   lockfile-only (`npm ci`, `uv sync --frozen`); forbid install-in-verify.
4. **Services** — every external service (database, queue, …): local
   default, env overrides, health check, CI service container image
   (pinned).
5. **Database** — dev DB, test DB creation/drop semantics, and the
   E2E state scope (isolated schema/database that a reset may touch).
6. **Browser / E2E** — browser engine(s), E2E dev server(s) + ports,
   preflight launch check, serial-vs-parallel assumptions.
7. **CI** — which canonical local command is the gate; runner pinning;
   service containers; artifact retention; consent flags set exactly once;
   static workflow contract test.
8. **Secrets / environment** — what is env-supplied, what is CI-only
   non-secret, what must never be committed; doctor/verify/summary
   output must not leak env values.
9. **AGENTS hierarchy** — root `AGENTS.md` (structure per this repo) +
   scoped files with verification ladders; routing table; scope-control
   list; stop conditions.
10. **Current-state doc** — `docs/CURRENT_STATE.md` (or equivalent) as the
    single live checkpoint; markers defined; no parallel status files.
11. **Architecture / domain docs** — one canonical owner per truth class;
    doc map with source-of-truth ownership.
12. **Canonical commands** — the §6-style table for the new repo (setup,
    dev, doctor, verify profiles, plan, summary, targeted ladders, E2E
    consent) — every command existence-checked.
13. **Doctor** — framework + repo probe list; optional capabilities
    declared; read-only contract preserved; contract tests.
14. **Verification profiles** — quick/static → complete non-browser →
    browser; mutation classes per phase; consent choke point for any
    destructive reset; summary JSON + correlation tiers; contract tests.
15. **Deterministic state** — reset + seeds + isolation + consent
    (double-gate at the choke point, behavior-tested); serial execution
    if state is shared.
16. **CI adoption** — workflows run exactly the canonical commands;
    artifacts on success AND failure, never on cancellation; advisory vs
    protected decision recorded.
17. **Observability** — adopt or defer deliberately: if adopted,
    control surface + OTel template + ledger + relay (per §33 reuse
    rules); product-home registration; host integration coordination
    (one per host!); privacy contract re-asserted (loopback, redaction,
    gitignore).
18. **Privacy** — secret scan of doctor/summary/relay/ledger outputs;
    gitignore coverage of all runtime artifact paths (contract-tested).
19. **Host integration** — single global integration (§31/§33); status/
    uninstall/rollback documented; fail-open verified.
20. **Contract tests** — the harness suite for the new repo (verify,
    doctor, workflow, observability if adopted) runnable in CI-adjacent
    form and directly.
21. **Fresh-agent smoke test** — §36 conformance run; fix harness, not
    the agent, when it fails.
22. **Commit gate** — define the slice→main workflow (branching, commit
    gate, clean-tree check, CI evidence before branch deletion) and record
    branch-protection status as a documented fact.

## 36. Conformance test for a new repository

**PORTABILITY TARGET** (acceptance definition; NOT implemented as a
command in this task). "Harness-ready" means a **fresh agent with no
conversation history** can, in one bounded session on the new repo:

| # | Step | Observable PASS condition | FAIL signal |
|---|---|---|---|
| 1 | Discover root instructions | the session's first actions read/cite the root `AGENTS.md` (its rules are referenced in the plan) | agent plans without referencing it, or references a stale/duplicate instruction file |
| 2 | Identify relevant scoped instructions | names + reads the scoped `AGENTS.md` for the touched area before editing | edits the area without reading its scoped file |
| 3 | Inspect git state without damaging WIP | runs `git status --short` / branch/HEAD checks read-only; pre-existing unrelated changes are acknowledged and preserved | any destructive git command on the pre-existing tree |
| 4 | Find current/architecture/domain context | reads the checkpoint + at most the task-relevant docs (names them); does not bulk-read all docs | reads the whole doc tree, or proceeds without the checkpoint for a state-sensitive task |
| 5 | Run/read doctor correctly | invokes the repo doctor (human or `--json`) and uses its statuses in the report; on a blocker applies the environment budget (≤1 retry with diagnosis, then classified status) | installs to "fix" a blocker; retries beyond budget; ignores a `blocked` capability |
| 6 | Identify targeted verification | runs the smallest relevant subset for the change first (per the scoped ladder) | jumps straight to the full profile with no targeted run |
| 7 | Identify broad / commit gate | runs the repo's complete non-browser gate before finishing (and browser gate only if required + consented, with the consent env set) | finishes a file-changing slice with no complete gate, or runs destructive reset without consent |
| 8 | Distinguish evidence levels | the completion report uses exactly the five statuses with correct mapping (e.g. typecheck-only work is never RUNTIME_VERIFIED) | any status upgrade beyond executed evidence; "all green" with omitted gates unstated |
| 9 | Classify failures correctly | every failed/suspicious result carries exactly one of the four classes with evidence + product-path-reached + allowed next action | unclassified failure, or weakening a test to green, or opportunistically fixing an out-of-scope discovery |
| 10 | Preserve unrelated changes | final diff touches only the slice's files; pre-existing WIP byte-identical (or explicitly reported) | unrelated files modified/reverted; blanket staging |
| 11 | Produce required completion evidence | the mandatory completion table exists: one row per required gate + deliberately omitted gates, exact commands, real exit results, product-path flags, real artifact paths | missing table, missing omitted-gate rows, invented artifact paths |

PASS = all 11 rows pass in a single fresh session on a bounded,
pre-published task (e.g. a small doc-adjacent or single-app change with a
known green baseline). Any FAIL is a harness defect (instructions,
routing, or command surface) and must be fixed in the harness, not worked
around by the agent. Re-run until PASS; record the result as the repo's
harness-readiness evidence.

## 37. Change-impact / maintenance matrix

**CURRENT IMPLEMENTATION** (populated from the actual components):

| If this changes | Also review / test |
|---|---|
| AGENTS contract (root or scoped) | fresh-agent smoke / conformance test (§36); doc map routing; any command names cited in it |
| Doctor capability list or statuses | `scripts/tests/agent-doctor.test.sh`; `docs/living-lab.md` doctor section; `agent-verify` `plan` prerequisites text; optional-capability gating |
| Verify profile or phase list | `scripts/tests/agent-verify.test.sh`; CI workflows (if a profile is a gate) + `core-workflow.test.sh` / `e2e-workflow.test.sh`; scoped `AGENTS.md` ladders; WORKFLOW.md "Flow" |
| Summary JSON schema | `agent-verify.test.sh`; ledger verification-correlation (agentRunId); CI artifact expectations |
| Ledger schema (`ledger-contract.json`) | `ledger.py`; `agent-observability.test.sh` (ledger section); `docs/agent/OBSERVABILITY.md` Run Ledger section; consumers must branch on `schema_version` |
| Trace contract (`trace-contract.json`) | Codex version compatibility note; `native-probe`; collector transform (dropped set); ledger raw-scan |
| ACP lifecycle / relay | `scripts/tests/agent-product-launch.test.sh` (lifecycle + framer units); `acp-fake-server.py` / scenario driver; **real product acceptance** (normal chat, prompts A/B, no manual stop) — the fixture suite is necessary but the real acceptance is the pin for host behavior |
| OTel capture (template/sanitization) | `agent-observability.test.sh` (fake-secret section, conditional collector e2e); `agent-observability doctor` end-to-end; privacy contract table (§20); `pins.json` integrity |
| Host integration (install/trampoline/config) | `agent-product-launch test` (install/uninstall/status/rollback/trampoline e2e); real `status` from the controller shell; fail-open fallback; one-integration-per-host rule |
| E2E reset / seeds / state | `accounts/test_reset_e2e.py`; `agent-verify` e2e refusal; `e2e-workflow.test.sh` (consent once); `docs/living-lab.md` seed/reset; E2E specs that assume fixture data |
| Environment variables (`FG_*`) | every script + test that sets/reads them; OBSERVABILITY.md env table; relay log overrides |
| CI workflows | the matching static contract test (same day); WORKFLOW.md "CI gates"; artifact/cancellation semantics |
| Codex / codex-acp / collector versions | trace contract re-verification (`native-probe` + observability suite); `pins.json` + `install` + `doctor`; version-compatibility note in OBSERVABILITY.md |
| Run context enums (`task_type`, …) | `runcontext.py`; ledger context section; root `AGENTS.md` orchestration wording; task templates that supply the values |

## 38. Versioning and upgrade strategy

**CURRENT IMPLEMENTATION — what exists today:**

| Artifact | Version field | Current value | Compatibility rule |
|---|---|---|---|
| `docs/agent/trace-contract.json` | `schemaVersion` | 2 | raw field names outside the contract are implementation detail; re-verify on Codex upgrades |
| `docs/agent/ledger-contract.json` | `schemaVersion` | 2 | v2 is a strict field superset of v1; consumers branch on `schema_version`; v1 records never rewritten in place |
| ledger record | `schema_version` | 2 (written by `ledger.py`; see the documented-drift note in §22.3) | idempotent re-normalization is explicit per run |
| `capture-manifest.json` | `schema_version` | 1 | finalized manifest is the normalization input |
| `run-context.json` | `schema_version` | 1 | fail-closed on unsupported version (exit 7) |
| `annotations.json` | `schema_version` | 1 | append-only |
| `product-runtime.json` | `schema_version` | 1 | fail-closed on unsupported version |
| agent-verify summary JSON | `schemaVersion` | 1 | fail-fast contract pinned by tests |
| doctor JSON | `schemaVersion` | 1 | stable capability order |
| `start --json` | `schema_version` | 1 | single-write document |
| `pins.json` (collector) | `schemaVersion` + version + SHA-256 | 1 / 0.161.0 | upgrade = edit pins + re-run `install` + `doctor`/`native-probe` |
| Codex / codex-acp | `sourceVersions` in trace contract | 0.148.x / 1.7.0 (ACP v1) | event names derived from 0.148.0 source — re-verify after upgrades |

There is **no** harness "core version" today (each repo carries its own
copies) — that is itself the portability problem.

**PORTABILITY TARGET / RECOMMENDED FUTURE ARCHITECTURE — proposed:**

- Give the shared Core a semantic version; repository adapters declare the
  Core version range they were conformed against (in the adapter config).
- Keep all persisted artifacts versioned exactly as today (each file
  carries its own `schema_version`); Core upgrades must read old versions
  and write new ones explicitly (the v1→v2 ledger rule is the template:
  additive superset, no in-place rewrite, explicit per-run re-normalization).
- Migrations are per-artifact and deterministic (no wall clock); a missing
  dimension in old data is an explicit gap, never back-filled.
- Upgrading several repositories without drift: bump the Core once, run
  conformance (§36) + the Core's own contract tests per repo, and record
  the Core version in each repo's harness-readiness evidence. Trace
  contract changes follow the Codex upgrade, not the Core version.

## 39. Troubleshooting decision tree

**CURRENT IMPLEMENTATION** (evidence-first; each route: first evidence →
command → likely class → when to stop). No destructive recovery commands
beyond canonical safe ones (`stop`, `uninstall`, opt-out).

1. **Agent ignores repo instructions** — evidence: session transcript vs
   `AGENTS.md` content. Command: none (inspect files; confirm the runtime
   actually injects root `AGENTS.md`). Class: harness/instruction defect
   (ENVIRONMENT_OR_HARNESS for the run; a harness-repair task otherwise).
   Stop: fix the instruction file (harness task), then re-run the conformance
   smoke (§36) — do not keep negotiating with the agent.
2. **Doctor reports blocked capability** — evidence: `--json` capability
   `detail`. Command: `./scripts/agent-doctor.sh --json`. Class:
   ENVIRONMENT_OR_HARNESS. Apply the environment budget (one attempt, one
   diagnosed retry, then NOT_VERIFIED_ENVIRONMENT_BLOCKED + the exact
   external command). Stop: never install/retry-loop.
3. **Verification fails** — evidence: the failing phase's output. Command:
   re-read the phase command from `agent-verify plan <profile>`; inspect
   the named failing test/assertion. Class: PRODUCT_REGRESSION vs
   STALE_TEST vs ENVIRONMENT_OR_HARNESS per §9 evidence rules. Stop: a
   PRODUCT_REGRESSION becomes a dedicated bug task; do not widen scope.
4. **CI differs from local** — evidence: local vs CI summary JSONs
   (phase-by-phase). Command: `agent-verify plan` comparison; diff the CI
   env (Postgres image, Node/uv versions) against local doctor JSON.
   Class: usually ENVIRONMENT_OR_HARNESS (pinned-version drift);
   PRODUCT_REGRESSION if the same phase fails identically in both. Stop:
   fix the environment pin, not the product, when evidence says environment.
5. **Collector won't start** — evidence: `start` error (exit 3 = binary
   missing, 4 = port). Command: `./scripts/agent-observability status`;
   `./scripts/agent-observability doctor`. Class: ENVIRONMENT_OR_HARNESS.
   Remedies: `install`, free the port or `FG_OBS_PORT`. Stop: if the
   sandbox cannot bind loopback, capture is unavailable there — run from
   the controller shell.
6. **OTLP port occupied** — evidence: `start` exit 4. Command: `status`
   (names the running run). Class: ENVIRONMENT_OR_HARNESS. Remedy: stop
   the running capture or set `FG_OBS_PORT`. Stop: never kill unknown
   processes.
7. **No current run** (`context current` exit 10 / `current-run` 10) —
   evidence: relay event log (`relay-started` present? `turn-start`?
   `start-error`?). Command: `tail .artifacts/agent-observability/
   relay-events.log`; `status`. Class: ENVIRONMENT_OR_HARNESS (or a
   harness defect if the relay is in the chain but fails). Read the
   failure-boundary table in §16.3/OBSERVABILITY.md. Stop: if no
   `relay-started`, the problem is upstream of the relay (trampoline /
   wrapper degradation) — that is a host-integration task, not a capture
   retry.
8. **Run does not finalize** — evidence: `status` (run still
   `running`), relay log (`turn-response` present? `turn-finalize`?).
   Command: inspect the run dir + relay log. Class: harness defect if the
   prompt response arrived but no `turn-finalize`; otherwise the turn is
   genuinely still active. Remedy (manual): `agent-observability stop
   --stop-status interrupted` to reconcile an orphaned run (canonical,
   safe). Stop: never edit the run dir by hand.
9. **Session/run mapping missing** — evidence: `session-runs/` dir; relay
   log (`mapping-written` vs `mapping-write-failed`). Class: harness
   defect / environment (writable `.artifacts`?). Effect: the turn is
   uncaptured but live and still finalizes (fail-open by design). Stop:
   check the run dir is writable; do not fabricate mappings.
10. **Verification attached to the wrong run** — evidence: the summary's
    `agentRunId` vs the run's conversation id / timestamps. Command:
    re-run with explicit `FG_AGENT_RUN_ID` from `current-run`. Class:
    ENVIRONMENT_OR_HARNESS (correlation), or a genuine defect if the
    mapping pointed at the wrong turn. Stop: the ledger rejects foreign
    `agentRunId` (exit 8) — that refusal is correct behavior, not a bug.
11. **Product runtime not registered** — evidence: `status` shows
    `not registered` / `corrupt`; `config` refuses. Command: `product-
    runtime register` **from inside a product-agent session**. Class:
    setup gap (ENVIRONMENT_OR_HARNESS). Stop: never copy a home from
    generic discovery — registration is evidence-only.
12. **Wrong Codex version** — evidence: ledger `runtime.app_versions` vs
    `codex_version` gap. Command: inspect `raw/logs.jsonl` `app.version`
    values. Class: if several values, the run mixed Codex processes —
    `codex_version_unresolved` is correct (no guess). Stop: do not "fix"
    by substituting the PATH version; fix the product session's Codex if
    the value is genuinely unexpected.
13. **Relay cannot parse ACP** — evidence: relay log `observe-error` /
    `frame-skipped` frequency; framer units. Command: run
    `scripts/tests/fixtures/ndjson-framer-units.py` + the product-launch
    suite. Class: harness defect (protocol drift — check codex-acp
    version). Stop: protocol changes need the fixture suite updated first.
14. **Host integration missing / inconsistent** — evidence: `agent-
    product-launch status` exit 7/8 (read from the **controller shell**).
    Command: `status`; inspect trampoline/delegate/config agreement.
    Class: setup gap. Remedy: `uninstall && install` (canonical, rollback-
    verified). Stop: one integration per host (§33); never hand-edit the
    trampoline.
15. **Dirty tree / unrelated WIP** — evidence: `git status --short` at
    PRECHECK. Command: none beyond read-only git. Class: SCOPE_DISCOVERY if
    verification then fails on the foreign WIP. Remedy: preserve the WIP,
    scope the slice around it, stage exact files; escalate if the task
    cannot proceed without the foreign changes. Stop: never reset/checkout
    away foreign WIP.

## 40. Known limitations and deliberate non-goals

**CURRENT IMPLEMENTATION** (verified limitations; do not "fix" by
re-documenting them as solved):

- **Concurrency**: one loopback endpoint / one capture directory per
  collector lifecycle → exactly one automatically observed prompt turn at
  a time; concurrent turns fail open (§17.4).
- **Single collector endpoint**: `127.0.0.1:4318` (env-overridable); a
  second simultaneous capture on the same host requires a different port
  and manual correlation.
- **Cross-run analytics / dashboards**: not implemented; the ledger is a
  per-run normalized record; comparability is presence-of-evidence only
  (§13, §24).
- **Missing comparability dimensions stay null**: `reasoning_effort` is
  absent for default/auto runs (0.148.0 emits it only when set); nothing
  is inferred.
- **Optional annotations**: human intervention is recorded only when
  explicitly annotated; `correction_occurred: null` means unknown, not no.
- **Metrics availability**: `no_metrics_file` / `token_usage_unavailable`
  are normal states for some captures (SSE fallback may or may not apply).
- **Host-specific integration**: one trampoline per host pointing at one
  repo (§15.4); the controller/agent identity boundary makes
  `agent-verify`'s tier-3 auto-correlation same-identity only (§8.5).
- **Prose-only process rules**: evidence statuses, failure classification,
  session choice, commit discipline are compliance-only (§28).
- **Branch protection**: deliberately disabled; CI gates are advisory
  (current documented fact, §11).
- **Eval is paused/separate**: `evals/` holds one pilot case package
  (`activity-feed-query-cost`); Eval work is not resumed by product
  sessions (§41).
- **Codex version attribution**: multi-value runs stay unresolved (by
  design, §23); the manifest never seeds a version from the collector
  shell.
- **Ledger contract doc drift**: one stale "currently 1" line in
  `ledger-contract.json` vs the implemented `schema_version: 2` (§22.3).
- **E2E test debt**: `e2e/project-work-item-inspector.spec.ts` is a
  temporary validation spec (test debt, per `CURRENT_STATE.md`), not a
  permanent regression signal.
- **Doctor cannot verify product behavior**: it is a capability preflight
  only (§7.4).
- **Sandbox blindness**: the agent sandbox cannot read host integration
  dirs (`~/.local/bin`, `~/.local/share/lucid-codex-acp`) — host facts
  must be verified from the controller shell; `status` output from inside
  the sandbox about those paths is `not_checked`-prone.

Deliberate non-goals (design decisions, not debt): no automatic Codex
config editing (manual `[otel]` block), no retry/parallelism in verify, no
timestamp-based correlation anywhere, no quality scoring in the ledger, no
cloud telemetry, no monkey-patching, no cross-run inference.

## 41. Eval boundary

**CURRENT IMPLEMENTATION.**

- **Shared** between the product Harness and `evals/`: the per-run
  runtime/eval metadata field contract (`docs/agent/RUNTIME.md`) — the
  binding field list every eval run must record; and, incidentally, the
  same verification tooling an eval agent would use inside its workspace.
- **Eval-only**: the historical-state case packages (`evals/cases/*`),
  the isolation contract (single baseline commit, no remote, task text
  external, hidden acceptance on a private verification copy), and the
  outer-harness filesystem/network enforcement (an explicit outer
  harness responsibility, per `evals/README.md`).
- **Why the boundary matters**: Eval infrastructure must never become
  required for normal product work — no product command, profile, doctor
  capability, or CI gate references `evals/`; observability explicitly
  leaves `evals/` untouched; and the Eval *outer harness* is not part of
  this repository's agent harness at all (it is the system that launches
  pinned-state workspaces).
- **Current Eval status** (canonical docs): `evals/` contains the pilot
  case package `activity-feed-query-cost` (a historical-state eval case);
  the README documents the isolation contract and its outer-harness
  limitation. No Eval runner or schema exists in the repository (the
  RUNTIME.md contract is a field contract only, "no machine-readable eval
  schema, file, or runner is introduced").

## 42. Glossary

| Term | Definition |
|---|---|
| Harness | the repository-owned mechanisms of §1.2 (instructions, doctor, verify, evidence contract, observability, contract tests, CI wiring) |
| run | one observability capture: one collector lifecycle with its own run directory; in the automatic product path, one per prompt turn |
| turn | one ACP `session/prompt` request + its matching response (the foreground agent work unit; the run boundary) |
| ACP session | the long-lived conversation identity (native Codex thread id = `CODEX_SESSION_ID`); grouping dimension, not a run boundary |
| prompt turn | synonym for turn; the `session/prompt` request/response pair |
| collector | the local `otelcol-contrib` process receiving loopback OTLP and writing sanitized raw files |
| ledger | the normalized per-run record (`run-ledger.json`, schema v2) — the normalization boundary above raw capture |
| manifest | `capture-manifest.json`: capture-session metadata incl. start/end Git evidence and observed conversation ids |
| evidence gap | a stable code in `evidence_gaps` naming missing optional evidence (never guessed values) |
| capability | one doctor probe result (e.g. `chromium_launch`) with a status (available/unavailable/blocked/unknown) |
| verification profile | a named ordered phase list in `agent-verify` (quick/frontend/backend/core/e2e/full) |
| final gate | the complete verification required before a slice is done (`core` non-browser; `full` with E2E where browser evidence is required) |
| product runtime | the host-managed Codex the product agent runs in (its `CODEX_HOME`; the only home that matters for product telemetry) |
| controller runtime | the standalone Codex of the developer shell (informational only; never the product destination) |
| CURRENT session | continue the existing agent session (same root cause / direct continuation) |
| NEW session | start a fresh agent session (new feature/domain/root cause, or after debugging pollution) |
| root / scoped AGENTS | `AGENTS.md` at the repo root (auto-discovered) vs `apps/*/AGENTS.md` supplements (read per PRECHECK) |
| canonical source | the single owner of a truth class (per the `docs/README.md` ownership map) |
| runtime verified | RUNTIME_VERIFIED: the specific claimed behavior was executed and observed (never derivable from static checks) |
| environment blocked | NOT_VERIFIED_ENVIRONMENT_BLOCKED: verification could not run; concrete blocker reproduced; nothing claimed about the path |
| stopReason | the bounded enum in the `session/prompt` response marking prompt-turn completion (the graceful-finalization trigger) |
| trampoline / delegate | the installed host launcher shim / the original launcher it forwards to |
| fail-open | observability failure leaves the product path intact (one bounded warning; no retries, no auto-install) |

## 43. Complete file/component map (appendix)

**CURRENT IMPLEMENTATION** — generated from repository inspection at
`8f2deae`. Owner/category: CORE / CONFIG / REPO KNOWLEDGE / HOST per §29.
"Primary tests" = the suite that pins the component.

| Path | Role | Category | Generic vs FG-specific | Primary tests |
|---|---|---|---|---|
| `AGENTS.md` | root instructions: scope, routing, rules, working method | REPO KNOWLEDGE (CORE shape) | FG content | conformance (§36); contract search in WORKFLOW.md |
| `apps/api/AGENTS.md` | backend scoped instructions + verification ladder | REPO KNOWLEDGE | FG | (instruction; commands verified by backend profile) |
| `apps/web/AGENTS.md` | frontend scoped instructions + Playwright rules | REPO KNOWLEDGE | FG | (instruction; commands verified by frontend profile) |
| `README.md` | human setup/dev runbook | REPO KNOWLEDGE | FG | — |
| `docs/README.md` | documentation map + source-of-truth ownership | REPO KNOWLEDGE (CORE shape) | FG | — |
| `docs/CURRENT_STATE.md` | single live implementation checkpoint | REPO KNOWLEDGE | FG | — (must move with slices) |
| `docs/product.md`, `docs/architecture.md`, `docs/living-lab.md`, `docs/design/*`, `docs/concepts/*` | product/architecture/testing/design truth | REPO KNOWLEDGE | FG | — |
| `docs/domain/*.md` (8 files) | domain invariants & semantics | REPO KNOWLEDGE | FG | Django/DRF behavior tests |
| `docs/agent/WORKFLOW.md` | canonical flow + Evidence contract | CORE | generic policy | `agent-verify.test.sh` (contract terms referenced); conformance |
| `docs/agent/RUNTIME.md` | runtime contract + per-run metadata fields | CORE | generic | — (field contract; consumed by evals) |
| `docs/agent/OBSERVABILITY.md` | observability specification | CORE + CONFIG | mechanism generic; values FG | observability + product-launch suites |
| `docs/agent/trace-contract.json` | versioned trace contract (v2) | CORE shape + CONFIG | Codex-version-specific | observability suite (template/pins) |
| `docs/agent/ledger-contract.json` | versioned ledger contract (v2) | CORE | generic | observability suite (ledger section) |
| `docs/agent/plans/*.md` | per-task planning docs | REPO KNOWLEDGE | FG | — |
| `scripts/agent-doctor.sh` | read-only environment doctor | CORE mechanism + CONFIG probes | mixed | `agent-doctor.test.sh` |
| `scripts/agent-verify.sh` | verification interface (profiles/plan/summary/correlation) | CORE mechanism + CONFIG commands | mixed | `agent-verify.test.sh` |
| `scripts/agent-observability` | observability control surface (12 subcommands) | CORE | generic | `agent-observability.test.sh` |
| `scripts/agent-product-launch` | host-integration install/status/uninstall + launch wrapper | HOST INTEGRATION bridge | host | `agent-product-launch.test.sh` |
| `scripts/observability/acp-lifecycle-relay.py` | transparent ACP relay + prompt-turn lifecycle | CORE | generic | product-launch suite + framer units |
| `scripts/observability/ledger.py` | Run Ledger normalizer (schema v2) | CORE | generic | observability suite (ledger section) |
| `scripts/observability/manifest.py` | capture manifest seed/finalize/summary + raw scan | CORE | generic | observability suite (manifest section) |
| `scripts/observability/liveness.py` | canonical EPERM-aware liveness semantic | CORE | generic | observability suite (via status/current-run) |
| `scripts/observability/productruntime.py` | product-runtime registration (bounded identity) | CORE | generic | observability suite |
| `scripts/observability/runcontext.py` | bounded run-context contract (enums/slugs) | CORE mechanism + REPO enum values | mixed | observability suite |
| `scripts/observability/otelcol-local.yaml` | collector config template (loopback, sanitization, rotation) | CORE mechanism + CONFIG knobs | mixed | observability suite (template assertions) |
| `scripts/observability/pins.json` | pinned collector version + SHA-256 per platform | CONFIG | pinned value | observability suite (integrity) |
| `scripts/observability/acp-probe-client.mjs` | native-probe ACP client | CORE | generic | observability suite (probe-client contract) |
| `scripts/tests/agent-doctor.test.sh` | doctor contract suite | CORE mechanism + CONFIG assertions | mixed | — (is a test) |
| `scripts/tests/agent-verify.test.sh` | verify/summary contract suite | CORE | generic | — |
| `scripts/tests/agent-observability.test.sh` | observability + ledger contract suite | CORE | generic | — |
| `scripts/tests/agent-product-launch.test.sh` | relay lifecycle + host-integration suite | CORE + HOST | mixed | — |
| `scripts/tests/core-workflow.test.sh` | CI core workflow static contract | CONFIG | FG CI wiring | — |
| `scripts/tests/e2e-workflow.test.sh` | CI e2e workflow static contract | CONFIG | FG CI wiring | — |
| `scripts/tests/fixtures/acp-fake-server.py` | fake long-lived ACP server (NDJSON) | CORE test fixture | generic | product-launch suite |
| `scripts/tests/fixtures/acp-scenario-driver.py` | lifecycle scenario driver | CORE test fixture | generic | product-launch suite |
| `scripts/tests/fixtures/fake-acp-adapter.mjs` | codex-acp 1.7.0-schema fake agent | CORE test fixture | version-specific | observability suite |
| `scripts/tests/fixtures/ndjson-framer-units.py` | byte-level NDJSON framer units | CORE test fixture | generic | product-launch suite |
| `.github/workflows/core.yml` | CI core gate (canonical `core` profile) | CONFIG | FG wiring | `core-workflow.test.sh` |
| `.github/workflows/e2e.yml` | CI E2E gate (canonical `e2e` profile + consent once) | CONFIG | FG wiring | `e2e-workflow.test.sh` |
| `playwright.config.ts` | E2E config: webServers (reset+runserver+vite), serial execution, chromium | CONFIG | FG | `e2e-workflow.test.sh` (indirect); E2E suite |
| `playwright.diagnostics.config.ts` | browser-free diagnostics unit-test config | CONFIG | FG | `npx playwright test -c …` |
| `e2e/*.spec.ts` (25 specs) + `e2e/helpers.ts`, `my-work-helpers.ts` | browser E2E suite | REPO KNOWLEDGE | FG | E2E profile |
| `e2e/diagnostics/failure-diagnostics.ts` + `e2e/diagnostics/unit/` | bounded failure-diagnostics artifact (schemaVersion 1) | CORE mechanism + FG adoption | mixed | diagnostics unit config |
| `apps/api/accounts/management/commands/reset_e2e.py` | destructive E2E reset with double consent | CONFIG (pattern CORE) | FG | `apps/api/accounts/test_reset_e2e.py` |
| `apps/api/accounts/management/commands/seed_dev.py` | deterministic dev/E2E seed (users, group, projects) | REPO KNOWLEDGE | FG | `apps/api/accounts` seed tests |
| `apps/api/accounts/management/commands/seed_e2e_scope.py` | E2E scope fixtures | REPO KNOWLEDGE | FG | E2E authorization specs |
| `apps/api/config/settings_e2e.py` | E2E Django settings (isolated `fg_e2e` schema) | CONFIG | FG | E2E profile; reset tests |
| `.artifacts/` (git-ignored) | all runtime harness state (§21) | CORE convention | layout generic, content per-repo | observability suite (gitignore coverage) |
| `.gitignore` (`.artifacts/` entry) | keeps runtime state out of git | CORE convention | generic | observability suite |
| `.nvmrc`, `package.json`, `apps/api/pyproject.toml` | runtime version contracts (Node 24, workspaces, Python ≥ 3.12) | CONFIG | FG values | doctor probes; CI pins |
| `evals/README.md`, `evals/cases/activity-feed-query-cost/` | Eval isolation contract + pilot case | REPO KNOWLEDGE (Eval) | FG | outer harness (outside repo) |
| `~/.local/bin/lucid-codex-acp` (host) | installed trampoline | HOST INTEGRATION | host | product-launch suite (temp install); controller-shell `status` |
| `~/.local/share/lucid-codex-acp/{lucid-codex-acp.impl,agent-product-launch.json}` (host) | delegate backup + integration config | HOST INTEGRATION | host | product-launch suite |
| `$CODEX_HOME/config.toml` `[otel]` block (host, product home) | user-level telemetry opt-in | HOST INTEGRATION | host | `agent-observability config`/`status` (read-only) |

**End of document.** The machine-readable contracts
(`trace-contract.json`, `ledger-contract.json`) and the script sources are
the finer canonical detail everywhere this document points at them.
