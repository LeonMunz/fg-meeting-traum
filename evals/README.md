# Evals

Eval cases are created from **historical repository states**. Each case
package can produce a fresh, isolated agent workspace pinned to exactly
one historical baseline commit, and can grade a finished agent run with
hidden, behavior-based acceptance checks.

## Isolation contract

- The eval agent **never works in the full original repository**. The
  control repository is used read-only (no checkout of old commits, no
  branches/tags/worktrees for them).
- Every agent workspace contains **exactly one baseline commit and no
  remote** — no tags, no stashes, no extra branches, and no access to
  later git objects.
- The task text is passed to the eval agent **externally** and is never
  copied into the agent workspace.
- Control metadata (`control.md`) and the hidden acceptance checks
  remain **outside** the agent workspace.
- The measured agent diff (`git status --short`, full diff against the
  baseline commit, diff stat) is secured **before** the hidden
  acceptance runs.
- The hidden acceptance executes on a **private verification copy** of
  the agent's work state (including untracked files, without its
  `.git`), never on the measured workspace itself.
- Later fix commits, branches, reflogs, and hidden tests must not be
  reachable from the eval agent.

## Limitation (outer harness responsibility)

Snapshot isolation is a git-level guarantee only. When starting the
eval agent, the outer harness must additionally enforce **filesystem
isolation** and (where the case requires it) **network restrictions**:
the snapshot alone cannot prevent an agent from using an original
repository path it can access through other means, or from reaching
the upstream repository over the network.

## Per-run metadata

Every eval run must capture the runtime/eval metadata defined in
[`docs/agent/RUNTIME.md`](../docs/agent/RUNTIME.md) (timestamp, commit,
task/eval ID, harness, model ID/revision, `reasoning_effort`, tool set,
sandbox/permission profile, network status, time and retry budget,
result status, runtime duration, tool call count, unnecessary test
runs, false verification claims, human corrections, diff size). This
directory duplicates none of that contract.

## Cases

| Case | Category | Entry points |
|---|---|---|
| `cases/activity-feed-query-cost/` | small backend bug (query cost) | `prepare.sh` (workspace), `verify.sh` (grading) |

This slice contains **only the pilot case above** — there is no
generic eval runner and no case matrix yet.
