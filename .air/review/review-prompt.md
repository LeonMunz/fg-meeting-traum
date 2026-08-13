# FG Workspace — Agentic Review Guidelines

Review the submitted change against `AGENTS.md` and only the documentation relevant to the changed domain.

Prioritize high-value findings.

## 1. Scope

- Did the change implement only the requested task?
- Were unrelated files, refactors, dependencies, or future features added?

## 2. Correctness

- Does the requested behavior work?
- Are error paths and invalid transitions handled where relevant?

## 3. Domain invariants

For foundation changes, check `docs/domain/foundation.md`.

For meeting changes, check `docs/domain/meetings.md`.

Flag any silent divergence between code and canonical domain rules.

## 4. Authorization and data leakage

Treat this as high priority.

Check that:
- identity comes from authenticated server state,
- Project access is enforced server-side,
- collection endpoints do not leak inaccessible objects,
- Viewer/Member/Owner behavior matches the domain rules,
- private Project data is not exposed through unrelated contexts.

## 5. Single source of truth

Flag duplicated persistent relationships or feature-specific copies of canonical business entities.

My Work, Project Board, Dashboard, and Meetings should project the same underlying Work Items.

## 6. Data modeling

Check that many-to-many relationships are relational where appropriate.

Do not assume API ID arrays should be PostgreSQL arrays.

Check constraints and migrations for model changes.

## 7. Tests

New or changed domain rules should have focused tests.

Prioritize:
- invariants
- permission boundaries
- cross-feature integration behavior

Do not demand broad snapshot tests unless they add concrete value.

## 8. Frontend

For UI changes:
- preserve the established design language,
- inspect only the relevant Stitch reference,
- check accessibility for interactive controls,
- ensure frontend visibility is not used as authorization.

## 9. Maintainability

Flag:
- unnecessary abstractions
- hidden coupling
- duplicated business logic
- unsafe typing
- dead code
- unexplained dependency additions

Prefer a few concrete, high-impact findings over style nitpicks.
