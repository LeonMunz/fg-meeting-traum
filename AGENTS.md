# FG Workspace — Agent Instructions

## Purpose

Build FG Workspace incrementally as a multiuser research-group workspace.

The authoritative current implementation checkpoint is:
`docs/CURRENT_STATE.md`

This file is repository-wide. Domain-specific instructions live in
`apps/web/AGENTS.md` (frontend) and `apps/api/AGENTS.md` (backend). The
canonical agent execution flow lives in `docs/agent/WORKFLOW.md`.

## Stable technical direction

- Frontend: React, TypeScript, Vite, Tailwind CSS, React Router
- Backend: Python, Django 5.2 LTS, Django REST Framework
- Database: PostgreSQL
- Python project management: uv
- Architecture: modular monolith
- API style: REST
- Authorization: server-side, deny by default

Do not change these choices without an explicit architecture decision.

## Repository map

- `apps/web/` — React frontend
- `apps/api/` — Django backend
- `docs/` — durable product, domain, architecture, and Living-Lab documentation
- `docs/stitch_examples/` — visual reference exports only
- `evals/` — historical-state eval case packages (pilot: `cases/activity-feed-query-cost`); see `evals/README.md`
- `scripts/agent-verify.sh` — repository verification helper (profiles: `quick`, `frontend`, `backend`, `core`, `e2e`, `full`)
- `scripts/agent-doctor.sh` — read-only environment capability doctor (human + JSON)
- `scripts/tests/agent-doctor.test.sh` — doctor tests (formats, exit codes, simulated blockers)
- `scripts/tests/agent-verify.test.sh` — agent-verify harness tests (usage, plan mode, `--summary-json` contract)
- `scripts/tests/core-workflow.test.sh` — CI core workflow contract tests
- `scripts/tests/e2e-workflow.test.sh` — CI E2E workflow contract tests

## Documentation usage

Do **not** read all documentation for every task.

Read only the documentation relevant to the requested change:

- Product intent, scope, milestones → `docs/product.md`
- Technical architecture, boundaries, sequencing → `docs/architecture.md`
- Identity, research group, projects, memberships, work items → `docs/domain/foundation.md`
- Meetings, sections, items, templates, lifecycle, meeting→work → `docs/domain/meetings.md`
- Work Item definitions, Board semantics, Board ordering → `docs/domain/foundation.md` (Sections 3a, 7, 15)
- Current implemented vs. not-yet-implemented checkpoint → `docs/CURRENT_STATE.md`
- Tests, seed/reset, deployment, privacy, Living Lab → `docs/living-lab.md`
- Agent runtime contract, per-run runtime/eval metadata → `docs/agent/RUNTIME.md`
- Unsure where to look → `docs/README.md`

For UI implementation, inspect only the relevant Stitch screen. Do not scan all Stitch exports.

## Context discipline

Before coding:

1. Identify the smallest domain affected by the task.
2. Read only the relevant documentation.
3. Inspect only the relevant implementation files and nearby tests.
4. If the task conflicts with a documented invariant, stop and report the conflict.

Avoid reading:
- `node_modules/`
- `dist/`
- `.git/`
- generated files
- unrelated Stitch exports
- unrelated feature directories

unless the task explicitly requires them.

## Core domain rules

The following rules are always relevant:

- Research-group membership does not imply project access.
- Projects are private by default and require `ProjectMembership`.
- Authorization is enforced by the server, never only by the UI.
- Every Work Item belongs to exactly one Project.
- A Work Item assignee must be a Project `owner` or `member`; a `viewer` cannot be assigned.
- The Project creator becomes an `owner`.
- Every active Project must retain at least one `owner`.
- My Work, Project Board, Dashboard, and Meetings must reference the same canonical Work Items; do not create screen-specific copies.
- API representations may contain ID lists, but relational database relationships must remain relational.
- Do not expose private project data through group-level meeting views.
- Work Item Type, Status, and Label definitions are Project-configured; every Work Item references its own Project's definitions.
- Definition IDs (`typeDefinitionId`, `statusDefinitionId`, `labelDefinitionIds`) are the canonical Work Item API contract.
- Do not introduce new logic based on legacy fixed Work Item `type` / `status` strings.
- Backend authorization and scope checks are authoritative; the UI never grants access.
- Meeting occurrence structure is independent from its template after creation; editing an occurrence never mutates the template.
- Every MeetingItem belongs to exactly one MeetingSection.
- User-facing terminology must use `Research Group Meeting`, `Project Meeting`, and `Meeting Templates`.
- Internal backend naming may still use `MeetingSeries`; do not rename persistence models merely for presentation terminology.

For full semantics and invariants, read the relevant domain document.

## Working method

For every task, follow the canonical flow in `docs/agent/WORKFLOW.md`:
PRECHECK → BASELINE / REPRODUCE → PLAN → EDIT → FAST VERIFY → TARGET VERIFY →
FINAL VERIFY → REPORT.

Task discipline:
- One independently verifiable product outcome per task.
- Inspect before editing.
- Make the smallest coherent change that satisfies the task.
- Do not implement future steps preemptively.
- Do not perform unrelated improvements or refactors.
- Do not add dependencies unless the task explicitly approves them.
- Add or update tests for domain rules introduced or changed by the task.
- Stop when the requested Definition of Done is met.

Bug discipline:
- Reproduce before changing production code.
- Diagnostic labels (FACT / HYPOTHESIS / NEXT TEST), the debugging budget,
  the four error classifications, the five verification statuses, the
  environment budget, and the mandatory completion format are canonical in
  `docs/agent/WORKFLOW.md` (Evidence contract). Every diagnostic finding,
  verification claim, blocker report, and completion report follows that
  contract.

Structural validity:
- If your own edit introduces a parser, syntax, type, import, or server-boot failure, restore structural validity immediately before continuing diagnosis.
- Never continue behavioral debugging against code that does not parse or typecheck.

Verification boundary:
- Verification-only work must not silently become open-ended implementation.
- Verification may inspect code and execute tests.
- Stale selectors may be updated only when product behavior remains unchanged.
- If verification discovers a production regression not explicitly authorized for repair, report it and stop; do not opportunistically fix unrelated failures.

Test integrity:
- Never change product copy solely to satisfy a test selector.
- Never weaken behavioral assertions merely to accommodate implementation.
- Strict locator ambiguity is evidence to refine the locator, not a reason to blindly use `.first()`.

Session guidance:
- Use the **CURRENT** session only for the same root cause or a direct continuation.
- Start a **NEW** session for a new feature/domain/root cause, or after substantial debugging has polluted the context.

## Validation

`./scripts/agent-verify.sh` (repository root, any caller CWD) is the single
executable verification interface. Profiles:

- `quick` — fast static validation: repo hygiene, frontend typecheck,
  frontend lint, Django system check, migration-drift check. No unit tests,
  no builds, no backend test suite, no E2E. Safe in the agent sandbox.
- `frontend` — complete non-browser frontend: typecheck, lint, complete unit
  suite, design-token contract suite, production build.
- `backend` — complete backend: Django system check, migration-drift check,
  complete Django test suite (canonical uv environment).
- `core` — all complete non-browser validation: repo hygiene + `frontend` +
  `backend`. Strongest profile expected to pass in the agent sandbox.
- `e2e` — browser E2E only. Requires a browser-capable environment and
  `FG_ALLOW_E2E_RESET=1` (the configured Playwright startup resets the
  `fg_e2e` schema); refuses without the opt-in.
- `full` — `core` + `e2e`. Fails clearly when the E2E opt-in or browser
  environment is absent; never silently skips E2E.

Use `./scripts/agent-verify.sh plan <profile>` to inspect a profile's exact
commands, environment requirements, and mutation flags without executing.

Optional machine-readable run summary:
`./scripts/agent-verify.sh --summary-json <path> <profile>` additionally
writes exactly one versioned JSON file (`schemaVersion` 1) to the explicit
target path after a run-mode profile, on pass and on fail-fast (the failed
phase is recorded with its real exit code; all later phases as `not_run`).
The target directory must already exist; relative paths resolve against the
caller's working directory. Human-readable output and exit codes are
unchanged; without the flag no file is created; `plan` rejects the flag.
The summary is execution evidence only and never upgrades an Evidence
Contract status.
Targeted validation during development stays available (see `apps/web/AGENTS.md`
and `apps/api/AGENTS.md`), e.g. `npm run typecheck`, `npm run test:unit
--workspace=web`, or `uv run python manage.py test <app>` from `apps/api/`.

`./scripts/agent-doctor.sh` (read-only; `--json` for machine-readable output)
diagnoses which verification capabilities are available or blocked in the
current environment. It is not part of any verification profile. Status
values and exit codes are documented in `docs/living-lab.md` (Environment
doctor); the post-blocker environment budget is part of the canonical
evidence contract in `docs/agent/WORKFLOW.md`.

Verification claims, blocker classification, and completion reports follow
that same evidence contract (`docs/agent/WORKFLOW.md`, Evidence contract):
five verification statuses, four error classes, one environment budget, one
mandatory completion format.

Do not invent a new testing framework merely to complete a task.

## Scope control

Do not introduce without explicit approval:

- new runtime dependencies
- a frontend state-management/query library
- a different backend framework or database
- a generic RBAC engine
- realtime/WebSockets
- microservices
- event sourcing
- external integrations
- AI features
- workflow engines
- large generic abstractions

## Frontend rules

- Components do not access PostgreSQL, Django models, or localStorage directly.
- Server data is accessed through the frontend API/feature boundary.
- Keep local state for UI concerns such as open drawers, tabs, filters, and form drafts.
- Do not maintain a second permanent mock truth once a backend endpoint exists for the same data.
- Feature-specific UI stays in its owning feature.
- Cross-feature components are reused through a clear public feature interface when reuse is real.

## Backend rules

- Keep a modular monolith.
- Put domain logic and authorization on the server.
- List endpoints must be permission-filtered; forbidden objects must not leak through collections.
- Prefer relational constraints and explicit service/domain logic over duplicated denormalized truth.
- Authentication identity comes from the authenticated server session/request, not from a client-supplied user ID.
- Database migrations are part of model changes.

## Git

Do not commit, push, rebase, reset, or rewrite history unless explicitly asked.

Do not change lockfiles unless dependencies actually changed.

## Stop condition

When the current task is complete and validated, stop.

Do not continue into the next roadmap stage unless explicitly requested.
