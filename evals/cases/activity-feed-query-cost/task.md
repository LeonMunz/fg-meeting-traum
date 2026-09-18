# Task: Activity-Feed Query Costs

## Observed problem

The number of SQL queries issued by `GET /api/activity/` grows with the
number of meeting-related entries (meeting events) on the requested
page. Two content-comparable pages that differ only in how many meeting
events they contain issue a different number of queries for the same
code path, so the per-page cost of the feed scales with the meeting
event count instead of staying constant.

## Desired behavior

- The query count of a single authenticated `GET /api/activity/`
  request must **not depend on the number of meeting events on the
  page**: a page with more meeting events (e.g. 14 vs. 2) must not
  issue more queries than a content-comparable page with fewer.
- The API response must remain **unchanged**: same entries, same
  fields, same values (including the Project / Research Group context
  of meeting entries), same ordering, same permission-filtering and
  pagination behavior.
- Add a regression test that pins the query-cost invariant, e.g. two
  content-comparable requests with clearly different meeting event
  counts (such as 2 vs. 14 meeting events on the page) asserting that
  the request query count does not change between them.

## Relevant API path

- `GET /api/activity/` (authenticated aggregate Activity feed with
  bounded `?limit=` / `?offset=` pagination), served by the Django
  backend under `apps/api/`.

## Expected verification

- Targeted: the existing Activity feed test modules of
  `apps/api/audit_history` plus your new regression test.
- Broader: the backend verification ladder from `apps/api/`
  (`uv run python manage.py check`, migration drift check, and the
  Django test suite) as described in `apps/api/AGENTS.md`.

## Constraints

- No product or API contract changes: response shape, field names,
  values, ordering, pagination, and authorization semantics must stay
  identical.
- No new dependencies, no schema/migration changes, no new endpoints.
- The change is a query-cost fix with unchanged observable API
  behavior.
