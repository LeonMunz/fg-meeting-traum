# FG Workspace — Frontend (apps/web) Agent Instructions

This file supplements the root `AGENTS.md` for this application.
Repository-wide safety, domain, scope, and Git constraints remain binding.
This file adds frontend-specific execution and verification guidance.

## Stack

- React 19, TypeScript, Vite, Tailwind CSS, React Router.
- Server data is accessed through the frontend API/feature boundary; components do
  not touch PostgreSQL, Django models, or localStorage directly.
- Local state is for UI concerns only (open drawers, tabs, filters, form drafts).
- Do not maintain a second permanent mock truth once a backend endpoint exists.

## Frontend verification ladder

Verify in this order, widening only as far as the task requires:

1. **After structural TS/TSX edits:** run typecheck immediately — `npm run typecheck`
   (delegates to `tsc -b --pretty false`). Do not continue on a file that does not typecheck.
2. **After behavior changes:** run the smallest relevant unit test:
   - one spec file: `npm run test:unit --workspace=web -- <pfad-zur-testdatei>`
   - one test case: `npm run test:unit --workspace=web -- <pfad-zur-testdatei> -t "<testname>"`
   (`npm run test:unit` without `--workspace=web` is not a canonical root
   invocation — the root has no such script.)
3. **At task completion (non-browser):** run `./scripts/agent-verify.sh frontend`
   from the repository root (typecheck + lint + complete unit suite +
   design-token contract suite + production build).
4. **Targeted E2E** when the change touches a covered flow — canonical form
   from the repository root: `FG_ALLOW_E2E_RESET=1 ./scripts/agent-verify.sh
   e2e <spec>` (Playwright arguments pass through, e.g. `e2e/login.spec.ts`,
   `-g "<testname>"`, `--headed`, `--ui`; a direct `npx playwright test <spec>`
   needs the same consent). Requires a browser-capable environment and
   `FG_ALLOW_E2E_RESET=1` consent to the `fg_e2e` schema reset performed by
   the Playwright startup.
   The consent is enforced inside the `reset_e2e` management command itself,
   so `npm run test:e2e`, `npx playwright test`, and direct
   management-command invocations all refuse the reset (nonzero exit, before
   any database mutation) without exactly `FG_ALLOW_E2E_RESET=1`.
   `npx playwright test --list` starts no web server and performs no reset.
5. **Full/broad E2E** (`./scripts/agent-verify.sh e2e`) only when justified by
   task scope and in a browser-capable environment with the same consent.

## Playwright rules

- Playwright commands are run from the repository root because
  `playwright.config.ts` and `e2e/` live there.
- Prefer an existing failing spec and its Playwright trace over writing a new probe.
- Prefer `getByRole`, `getByLabel`, and scoped locators over brittle CSS/structural selectors.
- Treat strict-mode ambiguity as useful evidence about the DOM, not an inconvenience.
- Do not use `.first()` merely to silence ambiguity unless ordering itself is part of
  the product contract.
- No arbitrary sleeps; wait for real conditions or assertions.
- No `force`-click workarounds.
- No product-copy changes for selector convenience.
- Do not create throwaway probe specs when the existing test/trace can isolate the issue.
- Temporary diagnostics, probe files, `console` instrumentation, and test-only data
  attributes must be removed before completion.

## UI rules

- Green functional tests do not replace visual review.
- For UI/UX tasks, report exactly which screens and states require manual visual
  verification.

## Debugging

The root file's bug discipline applies verbatim: reproduce first, label FACT /
HYPOTHESIS / NEXT TEST, max 3 failed diagnostic experiments per blocker, max 2
materially different root-cause hypotheses, and STOP + report BLOCKED when the budget
is exhausted without materially new evidence. Restore structural validity (typecheck
passes) before any behavioral diagnosis.
