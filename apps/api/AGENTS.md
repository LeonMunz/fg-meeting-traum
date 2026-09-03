# FG Workspace — Backend (apps/api) Agent Instructions

This file supplements the root `AGENTS.md` for this application.
Repository-wide safety, domain, scope, and Git constraints remain binding.
This file adds backend-specific execution and verification guidance.

## Stack

- Python, Django 5.2 LTS, Django REST Framework, PostgreSQL.
- Modular monolith; `uv` for environment and tooling.
- Domain logic and authorization live on the server.

## Durable backend rules

- Authorization is server-side and deny by default.
- List endpoints must be permission-filtered; forbidden objects must not leak through collections.
- Relational invariants remain relational; do not replace relationships with duplicated denormalized truth.
- Database migrations are part of model changes — ship the migration with the model change.
- Authenticated identity comes from the server session/request, never from a client-supplied user ID.
- No client-only authorization semantics; the UI never grants access.
- CSRF is enforced by DRF session authentication for authenticated unsafe requests.

## Backend verification ladder

Run from `apps/api/`, widening only as far as the task requires:

1. **Django system check** — `uv run python manage.py check`.
2. **Migration integrity** — `uv run python manage.py makemigrations --check --dry-run`.
3. **Smallest relevant app/test subset** — `uv run python manage.py test <app>` (or a
   specific test method) for the changed area.
4. **Full backend suite** only when justified by scope.

A fast combined pass (system check + migration check + repo hygiene) is available via
`./scripts/agent-verify.sh backend` from the repository root. Targeted and full
application tests remain task-dependent and are not run automatically by the helper.

## Debugging

The root file's bug discipline applies verbatim: reproduce first, label FACT /
HYPOTHESIS / NEXT TEST, max 3 failed diagnostic experiments per blocker, max 2
materially different root-cause hypotheses, and STOP + report BLOCKED when the budget
is exhausted without materially new evidence. Do not escalate an application bug into
framework/runtime speculation without direct evidence.
