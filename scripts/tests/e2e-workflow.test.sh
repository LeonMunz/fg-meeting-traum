#!/usr/bin/env bash
#
# Static contract tests for the CI E2E workflow (.github/workflows/e2e.yml).
#
# Run:  bash scripts/tests/e2e-workflow.test.sh
#
# Requires: bash only (plus actionlint, if installed, for a full
# GitHub-semantic lint pass). No new dependencies are introduced: the
# checks below are the security- and contract-critical invariants of the
# workflow, not a second full copy of it.
#
# Coverage:
#   * workflow file exists
#   * triggers are exactly pull_request(main) + push(main) + workflow_dispatch
#     (no pull_request_target, no schedule/workflow_run/release/...)
#   * permissions are limited to contents: read (no id-token, no write)
#   * exactly one job, on a pinned ubuntu generation (no ubuntu-latest)
#   * a job timeout is set
#   * every uses: reference is a full 40-char commit SHA (no @vN tags)
#   * the PostgreSQL service is pinned to the repo contract (postgres:16)
#     with a pg_isready healthcheck and a 5432 port mapping
#   * setup is reproducible: npm ci (no npm install), uv sync --frozen,
#     Playwright chromium only (the only configured browser project)
#   * no direct `npm run test:e2e` / `playwright test` gate call: the only
#     E2E invocation is the canonical scripts/agent-verify.sh e2e profile
#     with the --summary-json target
#   * FG_ALLOW_E2E_RESET appears exactly once, on the canonical gate line
#   * upload conditions carry the exact success / failure / cancellation
#     matrix: summary on ${{ !cancelled() }} (success yes, failure yes,
#     cancel no); failure artifacts on ${{ failure() && !cancelled() }}
#     (success no, failure yes, cancel no); no unprotected always()
#   * only the allowed artifact paths are referenced; retention is 14 days
#   * actionlint (when installed) reports no issues
#
# Not covered here (no YAML library / actionlint in the agent sandbox):
# full YAML syntax and GitHub-semantic validation. These run in CI
# (GitHub parses the workflow) and wherever actionlint is available.

set -Eeuo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WF="$REPO_ROOT/.github/workflows/e2e.yml"

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
[ -f "$WF" ] || { printf 'agent-verify workflow tests: FAIL (no workflow file)\n'; exit 1; }

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
[ "$(count_matches '^[[:space:]]*timeout-minutes: [0-9]+$')" -ge 1 ] \
  && ok "t13 job timeout is set" \
  || bad "t13 job timeout is set"

# Action references: full commit SHAs only.
USES_TOTAL="$(count_matches '^[[:space:]]*uses:')"
USES_SHA="$(count_matches '^[[:space:]]*uses: [A-Za-z0-9_-]+/[A-Za-z0-9._-]+@[0-9a-f]{40}')"
[ -n "$USES_TOTAL" ] && [ "$USES_TOTAL" -ge 3 ] \
  && ok "t14 uses: references found ($USES_TOTAL)" \
  || bad "t14 uses: references found (got: $USES_TOTAL)"
[ "$USES_TOTAL" -eq "$USES_SHA" ] \
  && ok "t15 every uses: reference is a full 40-char commit SHA" \
  || bad "t15 every uses: reference is a full 40-char commit SHA (total: $USES_TOTAL, sha: $USES_SHA)"
[ "$(count_matches '^[[:space:]]*uses: .*@v[0-9]')" -eq 0 ] \
  && ok "t16 no @vN tag references" \
  || bad "t16 no @vN tag references"
[ "$(count_matches '^[[:space:]]*uses: [A-Za-z0-9_-]+/[A-Za-z0-9._-]+@[0-9a-f]{40} +# ')" -eq "$USES_SHA" ] \
  && ok "t17 every pinned action carries a version comment" \
  || bad "t17 every pinned action carries a version comment"
expect_not_contains "t18 no floating latest refs" "$WF_TEXT" "@latest"

# PostgreSQL service contract.
expect_contains "t19 postgres pinned to repo major version 16" "$WF_TEXT" "image: postgres:16"
expect_contains "t20 postgres healthcheck via pg_isready"      "$WF_TEXT" "pg_isready"
expect_contains "t21 postgres port mapping 5432:5432"          "$WF_TEXT" "5432:5432"
expect_not_contains "t22 no production secret refs for postgres" "$WF_TEXT" "\${{ secrets."

# Reproducible setup contract.
expect_contains     "t23 checkout with persist-credentials: false" "$WF_TEXT" "persist-credentials: false"
expect_contains     "t24 npm ci is the JS install"                 "$WF_TEXT" "npm ci"
expect_not_contains "t25 no npm install"                           "$WF_TEXT" "npm install"
expect_contains     "t26 uv sync --frozen (no lockfile update)"    "$WF_TEXT" "uv sync --frozen"
expect_contains     "t27 playwright chromium install with deps"    "$WF_TEXT" "npx playwright install --with-deps chromium"
[ "$(count_matches 'playwright install')" -eq 1 ] \
  && ok "t28 playwright browser install is chromium-only (single call)" \
  || bad "t28 playwright browser install is chromium-only (single call)"

# Canonical E2E gate: only scripts/agent-verify.sh may run the tests.
expect_not_contains "t29 no direct npm run test:e2e gate"  "$WF_TEXT" "npm run test:e2e"
expect_not_contains "t30 no direct playwright test call"   "$WF_TEXT" "playwright test"
expect_contains     "t31 canonical agent-verify call"      "$WF_TEXT" "FG_ALLOW_E2E_RESET=1 ./scripts/agent-verify.sh"
expect_contains     "t32 summary-json target in runner temp" "$WF_TEXT" '--summary-json "$RUNNER_TEMP/fg-e2e/e2e-summary.json"'
[ "$(count_matches '^[[:space:]]*e2e$')" -ge 1 ] \
  && ok "t33 e2e profile argument present" \
  || bad "t33 e2e profile argument present"
expect_contains "t34 summary target directory prepared" "$WF_TEXT" 'mkdir -p "$RUNNER_TEMP/fg-e2e"'

# The destructive-reset consent lives only on the E2E step.
[ "$(count_matches 'FG_ALLOW_E2E_RESET')" -eq 1 ] \
  && ok "t35 FG_ALLOW_E2E_RESET appears exactly once" \
  || bad "t35 FG_ALLOW_E2E_RESET appears exactly once"
GATE_LINE="$(grep 'FG_ALLOW_E2E_RESET' "$WF" || true)"
case "$GATE_LINE" in
  *"./scripts/agent-verify.sh"*) ok "t36 FG_ALLOW_E2E_RESET sits on the canonical gate line" ;;
  *) bad "t36 FG_ALLOW_E2E_RESET sits on the canonical gate line" ;;
esac

# Upload conditions — exact success / failure / cancellation matrix:
#   summary:    success=yes  failure=yes  cancel=NO  -> ${{ !cancelled() }}
#   failure:    success=no   failure=yes  cancel=NO  -> ${{ failure() && !cancelled() }}
[ "$(count_matches '^[[:space:]]*if: \$\{\{ !cancelled\(\) \}\}$')" -eq 1 ] \
  && ok "t37 summary upload iff !cancelled() (success+failure yes, cancel no)" \
  || bad "t37 summary upload iff !cancelled() (success+failure yes, cancel no)"
[ "$(count_matches '^[[:space:]]*if: \$\{\{ failure\(\) && !cancelled\(\) \}\}$')" -eq 1 ] \
  && ok "t38 failure-artifact upload iff failure() && !cancelled() (failure only, cancel no)" \
  || bad "t38 failure-artifact upload iff failure() && !cancelled() (failure only, cancel no)"
[ "$(count_matches 'always\(\)')" -eq 0 ] \
  && ok "t38a no unprotected always() anywhere in the workflow" \
  || bad "t38a no unprotected always() anywhere in the workflow"

# Only the allowed artifact paths; retention 14 days for both uploads.
BAD_PATH=0
while IFS= read -r line; do
  case "$line" in
    *"path: |"*) : ;; # block scalar: its entries are checked below
    *'path: ${{ runner.temp }}/fg-e2e/e2e-summary.json'*) : ;;
    *) BAD_PATH=1 ;;
  esac
done < <(grep -E '^[[:space:]]*path:' "$WF")
[ "$BAD_PATH" -eq 0 ] \
  && ok "t39 only allowed artifact path roots" \
  || bad "t39 only allowed artifact path roots"
expect_contains "t40 failure artifact path playwright-report/" "$WF_TEXT" "playwright-report/"
expect_contains "t41 failure artifact path test-results/"      "$WF_TEXT" "test-results/"
for forbidden in node_modules .venv .env coverage dist/ "test-results/.." "playwright-report/.."; do
  expect_not_contains "t42 no upload of forbidden path: $forbidden" "$WF_TEXT" "$forbidden"
done
[ "$(count_matches 'retention-days: 14')" -eq 2 ] \
  && ok "t43 both artifacts keep 14-day retention" \
  || bad "t43 both artifacts keep 14-day retention"
[ "$(count_matches 'retention-days:')" -eq 2 ] \
  && ok "t44 no other retention values" \
  || bad "t44 no other retention values"

# Deterministic artifact names keyed by run id + attempt.
[ "$(count_matches 'e2e-(summary|failure)-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}')" -eq 2 ] \
  && ok "t45 artifact names are deterministic per run id + attempt" \
  || bad "t45 artifact names are deterministic per run id + attempt"

# Optional: full GitHub-semantic lint when actionlint is installed.
if command -v actionlint >/dev/null 2>&1; then
  AOUT="$(actionlint "$WF" 2>&1)" && ok "t46 actionlint: no issues" \
    || { bad "t46 actionlint: no issues"; printf '%s\n' "$AOUT"; }
else
  printf 'skip t46 actionlint (not installed; GitHub-semantic validation not available here)\n'
fi

# ------------------------------------------------------------- summary ----
printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf 'e2e-workflow tests: PASS (%d checks)\n' "$PASS"
  exit 0
fi
printf 'e2e-workflow tests: FAIL (%d failed, %d passed)\n' "$FAIL" "$PASS"
printf 'failed: %s\n' "${FAILED[*]}"
exit 1
