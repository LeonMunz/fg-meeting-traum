#!/usr/bin/env bash
#
# Static contract tests for the CI Core verification workflow
# (.github/workflows/core.yml).
#
# Run:  bash scripts/tests/core-workflow.test.sh
#
# Requires: bash only (plus actionlint, if installed, for a full
# GitHub-semantic lint pass). No new dependencies are introduced: the
# checks below are the security- and contract-critical invariants of the
# workflow, not a second full copy of it. The canonical `core` phase list
# stays in scripts/agent-verify.sh; this test deliberately holds no second
# copy of it.
#
# Coverage:
#   * workflow file exists
#   * triggers are exactly pull_request(main) + push(main) + workflow_dispatch
#     (no pull_request_target, no schedule/workflow_run/release/...)
#   * permissions are limited to contents: read (no id-token, no write)
#   * exactly one job, on a pinned ubuntu generation (no ubuntu-latest),
#     with a bounded timeout
#   * concurrency cancels superseded PR runs only (pushes to main queued)
#   * every uses: reference is a full 40-char commit SHA with a version
#     comment (same pinning convention as the E2E workflow)
#   * the PostgreSQL service is pinned to the repo contract (postgres:16)
#     with a pg_isready healthcheck and a 5432 port mapping (the backend
#     test suite of the core profile creates and drops its test database)
#   * setup is reproducible: npm ci (no npm install), uv sync --frozen,
#     and NO Playwright browser installation (the core profile is
#     non-browser)
#   * no direct gate command: the only gate invocation is the canonical
#     scripts/agent-verify.sh core profile with the --summary-json target
#     outside the repository ($RUNNER_TEMP)
#   * summary upload iff ${{ !cancelled() }} (success yes, failure yes,
#     cancel no); no unprotected always(); no FG_ALLOW_E2E_RESET
#   * only the allowed artifact path is referenced; retention is 14 days
#   * no branch-protection configuration; no GitHub secrets
#   * actionlint (when installed) reports no issues
#
# Not covered here (no YAML library / actionlint in the agent sandbox):
# full YAML syntax and GitHub-semantic validation. These run in CI
# (GitHub parses the workflow) and wherever actionlint is available.

set -Eeuo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WF="$REPO_ROOT/.github/workflows/core.yml"

PASS=0
FAIL=0
FAILED=()

ok()   { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); FAILED+=("$1"); printf 'FAIL %s\n' "$1"; }

expect_exists() { # expect_exists <name> <file>
  if [ -f "$2" ]; then ok "$1"; else bad "$1 (missing: $2)"; fi
}

expect_contains() { # expect_contains <name> <haystack> <needle>
  case "$2" in
    *"$3"*) ok "$1" ;;
    *) bad "$1 (missing: $3)" ;;
  esac
}

expect_not_contains() { # expect_not_contains <name> <haystack> <needle>
  case "$2" in
    *"$3"*) bad "$1 (found: $3)" ;;
    *) ok "$1" ;;
  esac
}

count_matches() { # count_matches <pattern> -> stdout count
  grep -Eo "$1" "$WF" 2>/dev/null | wc -l | tr -d ' '
}

# --------------------------------------------------------- structure ------
expect_exists "t01 workflow file exists" "$WF"
[ -f "$WF" ] || { printf 'core-workflow tests: FAIL (no workflow file)\n'; exit 1; }

WF_TEXT="$(cat "$WF")"

# Triggers: exactly the three expected, both against main.
expect_contains  "t02 trigger pull_request present" "$WF_TEXT" "pull_request:"
expect_contains  "t03 trigger push present"         "$WF_TEXT" "push:"
expect_contains  "t04 trigger workflow_dispatch present" "$WF_TEXT" "workflow_dispatch:"
[ "$(count_matches '^[[:space:]]*branches: \[main\]$')" -eq 2 ] \
  && ok "t05 exactly two branch filters, both [main]" \
  || bad "t05 exactly two branch filters, both [main]"
for trig in pull_request_target workflow_run schedule release repository_dispatch deployment push_tag; do
  expect_not_contains "t06 no trigger: $trig" "$WF_TEXT" "$trig:"
done

# Permissions: contents read only.
expect_contains     "t07 permissions contents: read" "$WF_TEXT" "contents: read"
expect_not_contains "t08 no id-token permission"     "$WF_TEXT" "id-token:"
expect_not_contains "t09 no permissions write scope" "$WF_TEXT" ": write"

# Single job, pinned runner generation, bounded timeout.
[ "$(count_matches '^[[:space:]]*runs-on:')" -eq 1 ] \
  && ok "t10 exactly one job" \
  || bad "t10 exactly one job"
expect_contains     "t11 pinned runner generation ubuntu-24.04" "$WF_TEXT" "runs-on: ubuntu-24.04"
expect_not_contains "t12 no floating ubuntu-latest"             "$WF_TEXT" "ubuntu-latest"
[ "$(count_matches '^[[:space:]]*timeout-minutes: 45$')" -eq 1 ] \
  && ok "t13 job timeout is exactly 45 minutes" \
  || bad "t13 job timeout is exactly 45 minutes"
expect_not_contains "t13a no regression to the obsolete 30-minute limit" \
  "$WF_TEXT" "timeout-minutes: 30"

# Concurrency: cancel superseded PR runs only; pushes to main never cancelled.
expect_contains "t14 concurrency group set" "$WF_TEXT" "group: core-"
expect_contains "t15 cancellation limited to pull_request" \
  "$WF_TEXT" "cancel-in-progress: \${{ github.event_name == 'pull_request' }}"

# Action references: full commit SHAs only, version comments documented.
USES_TOTAL="$(count_matches '^[[:space:]]*uses:')"
USES_SHA="$(count_matches '^[[:space:]]*uses: [A-Za-z0-9_-]+/[A-Za-z0-9._-]+@[0-9a-f]{40}')"
[ -n "$USES_TOTAL" ] && [ "$USES_TOTAL" -ge 4 ] \
  && ok "t16 uses: references found ($USES_TOTAL)" \
  || bad "t16 uses: references found (got: $USES_TOTAL)"
[ "$USES_TOTAL" -eq "$USES_SHA" ] \
  && ok "t17 every uses: reference is a full 40-char commit SHA" \
  || bad "t17 every uses: reference is a full 40-char commit SHA (total: $USES_TOTAL, sha: $USES_SHA)"
[ "$(count_matches '^[[:space:]]*uses: .*@v[0-9]')" -eq 0 ] \
  && ok "t18 no @vN tag references" \
  || bad "t18 no @vN tag references"
[ "$(count_matches '^[[:space:]]*uses: [A-Za-z0-9_-]+/[A-Za-z0-9._-]+@[0-9a-f]{40} +# ')" -eq "$USES_SHA" ] \
  && ok "t19 every pinned action carries a version comment" \
  || bad "t19 every pinned action carries a version comment"
expect_not_contains "t20 no floating latest refs" "$WF_TEXT" "@latest"

# Same pinning convention as the E2E workflow (identical pinned SHAs).
for pin in \
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" \
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020" \
  "astral-sh/setup-uv@bec219d24cd3e171d82865faccec33120bb574f4" \
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"; do
  expect_contains "t21 pinned action shared with E2E workflow: $pin" "$WF_TEXT" "$pin"
done

# PostgreSQL service contract (the core profile's backend test suite
# creates and drops its own test database).
expect_contains "t22 postgres pinned to repo major version 16" "$WF_TEXT" "image: postgres:16"
expect_contains "t23 postgres healthcheck via pg_isready"      "$WF_TEXT" "pg_isready"
expect_contains "t24 postgres port mapping 5432:5432"          "$WF_TEXT" "5432:5432"
expect_not_contains "t25 no production secret refs for postgres" "$WF_TEXT" "\${{ secrets."

# Reproducible setup contract.
expect_contains     "t26 checkout with persist-credentials: false" "$WF_TEXT" "persist-credentials: false"
expect_contains     "t27 npm ci is the JS install"                 "$WF_TEXT" "npm ci"
expect_not_contains "t28 no npm install"                           "$WF_TEXT" "npm install"
expect_contains     "t29 uv sync --frozen (no lockfile update)"    "$WF_TEXT" "uv sync --frozen"

# The core profile is non-browser: no Playwright browser installation.
expect_not_contains "t30 no Playwright browser install" "$WF_TEXT" "playwright install"
expect_not_contains "t31 no Playwright test install"    "$WF_TEXT" "playwright test"

# Canonical core gate: only scripts/agent-verify.sh may run the phases.
expect_not_contains "t32 no direct npm run gate command" "$WF_TEXT" "npm run "
expect_not_contains "t33 no direct Django manage.py gate" "$WF_TEXT" "manage.py"
expect_contains     "t34 canonical agent-verify call"    "$WF_TEXT" "./scripts/agent-verify.sh"
[ "$(count_matches '^[[:space:]]*core$')" -eq 1 ] \
  && ok "t35 core profile argument present exactly once" \
  || bad "t35 core profile argument present exactly once"
expect_not_contains "t36 no E2E reset opt-in in the core workflow" "$WF_TEXT" "FG_ALLOW_E2E_RESET"

# Summary location: outside the repository, in runner temp.
expect_contains "t37 summary-json target in runner temp" "$WF_TEXT" '--summary-json "$RUNNER_TEMP/fg-core/core-summary.json"'
expect_contains "t38 summary target directory prepared"  "$WF_TEXT" 'mkdir -p "$RUNNER_TEMP/fg-core"'

# Upload conditions: summary on ${{ !cancelled() }} only (success yes,
# failure yes, cancel no); no unprotected always() anywhere.
[ "$(count_matches '^[[:space:]]*if: \$\{\{ !cancelled\(\) \}\}$')" -eq 1 ] \
  && ok "t39 summary upload iff !cancelled() (success+failure yes, cancel no)" \
  || bad "t39 summary upload iff !cancelled() (success+failure yes, cancel no)"
[ "$(count_matches 'always\(\)')" -eq 0 ] \
  && ok "t40 no unprotected always() anywhere in the workflow" \
  || bad "t40 no unprotected always() anywhere in the workflow"

# Only the allowed artifact path; retention 14 days for the single upload.
BAD_PATH=0
while IFS= read -r line; do
  case "$line" in
    *'path: ${{ runner.temp }}/fg-core/core-summary.json'*) : ;;
    *) BAD_PATH=1 ;;
  esac
done < <(grep -E '^[[:space:]]*path:' "$WF")
[ "$BAD_PATH" -eq 0 ] \
  && ok "t41 only the allowed summary artifact path is referenced" \
  || bad "t41 only the allowed summary artifact path is referenced"
for forbidden in node_modules .venv .env coverage "dist/" "github.workspace"; do
  expect_not_contains "t42 no upload of forbidden path: $forbidden" "$WF_TEXT" "$forbidden"
done
[ "$(count_matches 'retention-days: 14')" -eq 1 ] \
  && ok "t43 the summary artifact keeps 14-day retention" \
  || bad "t43 the summary artifact keeps 14-day retention"
[ "$(count_matches 'retention-days:')" -eq 1 ] \
  && ok "t44 no other retention values" \
  || bad "t44 no other retention values"

# Deterministic artifact name keyed by run id + attempt; no retries.
expect_contains "t45 artifact name is deterministic per run id + attempt" \
  "$WF_TEXT" 'name: core-summary-${{ github.run_id }}-${{ github.run_attempt }}'
expect_not_contains "t46 no retry configuration" "$WF_TEXT" "retry"

# No branch-protection configuration in the workflow.
expect_not_contains "t47 no branch protection configuration" "$WF_TEXT" "branch_protection"

# Optional: full GitHub-semantic lint when actionlint is installed.
if command -v actionlint >/dev/null 2>&1; then
  AOUT="$(actionlint "$WF" 2>&1)" && ok "t48 actionlint: no issues" \
    || { bad "t48 actionlint: no issues"; printf '%s\n' "$AOUT"; }
else
  printf 'skip t48 actionlint (not installed; GitHub-semantic validation not available here)\n'
fi

# ------------------------------------------------------------- summary ----
printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf 'core-workflow tests: PASS (%d checks)\n' "$PASS"
  exit 0
fi
printf 'core-workflow tests: FAIL (%d failed, %d passed)\n' "$FAIL" "$PASS"
printf 'failed: %s\n' "${FAILED[*]}"
exit 1
