# Agent Execution Workflow

This document defines the canonical flow every agent follows for a task. It is
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
- Do not proceed to behavioral diagnosis while the tree does not parse/typecheck.

### TARGET VERIFY

- Run the smallest relevant test subset for the changed behavior.
- Frontend: relevant unit tests, plus targeted E2E when a covered flow changed.
- Backend: the relevant app/test subset; migration check for model changes.

### FINAL VERIFY

- At task completion run the full relevant pass:
  - `./scripts/agent-verify.sh frontend` or `backend` (or `full`)
  - Plus any targeted E2E or app tests justified by scope.
- `git diff HEAD --check` must be clean.

### REPORT

- Report changed files, behavior, checks run and their results, and limitations.
- For UI/UX work, name the screens/states that need manual visual verification.
- For a bug, report the resolved FACT, the hypothesis that held, and the deciding test.

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

## Session guidance

- Use the **CURRENT** session only for the same root cause or a direct continuation of
  the current work.
- Start a **NEW** session for a new feature/domain/root cause, or after substantial
  debugging has polluted the working context.

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
