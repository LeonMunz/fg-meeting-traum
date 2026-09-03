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
- `scripts/agent-verify.sh` — repository verification helper (frontend / backend / full)

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
- Label every diagnostic finding explicitly as:
  - **FACT** — directly observed evidence.
  - **HYPOTHESIS** — a possible explanation, not a conclusion.
  - **NEXT TEST** — one test that can falsify or materially distinguish the hypothesis.
- Maximum 3 failed diagnostic experiments for one blocker.
- Maximum 2 materially different root-cause hypotheses.
- If that budget is exhausted without materially new evidence: STOP and report **BLOCKED** with the FACTs, hypotheses, and what was tried.
- Do not escalate an application bug into framework/runtime speculation without direct evidence.

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

For frontend changes, from repository root run:

```bash
npm run build
npm run lint
```

For a fast structural check use `npm run typecheck` (delegates to the web
workspace). For a combined frontend/backend verification pass use
`./scripts/agent-verify.sh frontend|backend|full`.

For backend changes (from `apps/api/`), at minimum run Django system checks, `makemigrations --check`, and the relevant backend tests:

```bash
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run python manage.py test <app>
```

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
