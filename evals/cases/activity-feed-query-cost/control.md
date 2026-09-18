# Control — activity-feed-query-cost

**Orchestrator-only metadata. Never provide this file to the eval
agent.**

| Field | Value |
|---|---|
| Case ID | `activity-feed-query-cost` |
| Category | small backend bug (per-page query cost scales with meeting event count) |
| Start commit (baseline) | `336bf466d8f1e8a9531f1e1bfd68d156c17cf0b3` |
| Historical reference fix | `e4736b272a5d5154b9dd0fb1b068b73d8bfdef2e` |
| Expected time budget (agent run) | 1–2 hours |
| Required infrastructure | Python/uv + PostgreSQL test database; no browser |
| Task text path | `evals/cases/activity-feed-query-cost/task.md` (passed externally; never copied into the agent workspace) |
| Acceptance path | `evals/cases/activity-feed-query-cost/acceptance/test_activity_feed_query_cost.py` (hidden; copied only into the private verification copy) |
| Prepare step | `bash evals/cases/activity-feed-query-cost/prepare.sh [TARGET_DIR]` |
| Verify step | `bash evals/cases/activity-feed-query-cost/verify.sh AGENT_WORKSPACE_DIR` |
| Expected baseline result | hidden acceptance **FAILS** on the query-growth invariant (query count grows with meeting rows); existing Activity feed regression tests **PASS** |
| Expected reference result | hidden acceptance **PASSES**; existing Activity feed regression tests **PASS** |

## Reference-fix note

The historical reference fix is named above for validation only. Its
full patch is deliberately **not** duplicated in this package, and the
hidden acceptance is an implementation-independent behavioral check
(query-count invariance + unchanged response content), not a
re-assertion of the historical diff.

## Leakage limits

`task.md` must contain none of: start/fix SHAs, the historical commit
message, the name or path of the production file the historical fix
changed, the specific missing ORM relation, the `select_related`
solution, patch excerpts, hidden-test names/paths, any reference to
the historical fix, or the fix's diff size.

The agent workspace must contain: exactly one commit (root tree
`4f6105e4a70c3221a75cc73898ff03445f7ccbe1`), no remote, no tags, no
stashes, no extra branches, and no access to the fix commit object.
`control.md`, the acceptance test, and the verifier must not be present
in the agent workspace.

## Runtime metadata per run (captured externally)

Per `docs/agent/RUNTIME.md`, the orchestrator must record per eval run
(mandatory field contract): timestamp; repository commit; task/eval ID;
harness; harness version (if available); model ID; model revision
(`UNKNOWN` if not exposed); serving engine and version (if available);
`reasoning_effort`; sampling parameters (if explicitly set); context
and output limits (if known); tool set; sandbox/permission profile;
network status; time and retry budget; result status; runtime duration;
tool call count; unnecessary test runs; false verification claims;
human corrections; diff size.
