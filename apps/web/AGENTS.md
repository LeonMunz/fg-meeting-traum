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
2. **After behavior changes:** run the smallest relevant unit test —
   `npm run test:unit --workspace=web` (optionally narrowed to the affected spec).
3. **At task completion:** typecheck + lint + relevant unit tests, plus targeted E2E
   when the change touches a covered flow —
   `npm run lint`, then `npx playwright test <spec>` for the relevant spec.
4. **Full/broad E2E** only when justified by task scope.

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
