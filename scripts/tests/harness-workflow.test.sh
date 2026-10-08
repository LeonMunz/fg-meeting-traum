#!/usr/bin/env bash
#
# Static contract tests for the CI Harness contracts workflow
# (.github/workflows/harness.yml).
#
# Run:  bash scripts/tests/harness-workflow.test.sh
#
# Requires: bash only (plus actionlint, if installed, for a full
# GitHub-semantic lint pass). No new dependencies are introduced: the
# checks below are the security- and contract-critical invariants of the
# workflow, not a second full copy of it. The canonical fast suite list
# stays in scripts/tests/harness-contracts.test.sh; this test
# deliberately holds no second copy of it.
#
# Coverage:
#   * workflow file exists
#   * triggers are exactly pull_request(main) + workflow_dispatch (no
#     push to main — main-push verification runs inside the release DAG,
#     publish-images.yml; no pull_request_target, no
#     schedule/workflow_run/release/...)
#   * permissions are limited to contents: read (no id-token, no write,
#     no secrets expression)
#   * exactly one job, on a pinned ubuntu generation (no ubuntu-latest),
#     with a bounded timeout (10 minutes, measured-suite budget)
#   * concurrency cancels superseded PR runs only (dispatch runs queued)
#   * every uses: reference is a full 40-char commit SHA with a version
#     comment; the checkout and setup-node pins are shared with the
#     standalone Core/E2E workflows
#   * checkout with persist-credentials: false; Node 24 (repo contract)
#   * no dependency installation (no npm ci / npm install / npm run, no
#     uv sync, no setup-uv)
#   * no PostgreSQL service, no Playwright/browser, no Docker
#   * exactly ONE canonical invocation:
#     `bash scripts/tests/harness-contracts.test.sh` — the individual
#     suite list is NOT duplicated in this workflow
#   * no artifact uploads (no upload-artifact, no retention); no
#     branch-protection configuration
#   * actionlint (when installed) reports no issues
#
# Not covered here (no YAML library / actionlint in the agent sandbox):
# full YAML syntax and GitHub-semantic validation. These run in CI
# (GitHub parses the workflow) and wherever actionlint is available.

set -Eeuo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WF="$REPO_ROOT/.github/workflows/harness.yml"
CORE_WF="$REPO_ROOT/.github/workflows/core.yml"
E2E_WF="$REPO_ROOT/.github/workflows/e2e.yml"
RUNNER="$REPO_ROOT/scripts/tests/harness-contracts.test.sh"

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
[ -f "$WF" ] || { printf 'harness-workflow tests: FAIL (no workflow file)\n'; exit 1; }
expect_exists "t02 canonical Harness runner exists" "$RUNNER"

WF_TEXT="$(cat "$WF")"

# Triggers: exactly the two expected, against main.
expect_contains  "t03 trigger pull_request present" "$WF_TEXT" "pull_request:"
[ "$(count_matches '^  push:$')" -eq 0 ] \
  && ok "t04 no push trigger (main-push verification lives in the release DAG)" \
  || bad "t04 no push trigger (found a push trigger)"
expect_contains  "t05 trigger workflow_dispatch present" "$WF_TEXT" "workflow_dispatch:"
[ "$(count_matches '^[[:space:]]*branches: \[main\]$')" -eq 1 ] \
  && ok "t06 exactly one branch filter, [main] (pull_request only)" \
  || bad "t06 exactly one branch filter, [main] (pull_request only)"
for trig in push pull_request_target workflow_run schedule release repository_dispatch deployment push_tag; do
  expect_not_contains "t07 no trigger: $trig" "$WF_TEXT" "$trig:"
done

# Permissions: contents read only, no secrets expression.
expect_contains     "t08 permissions contents: read" "$WF_TEXT" "contents: read"
expect_not_contains "t09 no id-token permission"     "$WF_TEXT" "id-token:"
expect_not_contains "t10 no permissions write scope" "$WF_TEXT" ": write"
expect_not_contains "t11 no secrets expression"      "$WF_TEXT" '${{ secrets.'

# Single job, pinned runner generation, bounded timeout.
[ "$(count_matches '^[[:space:]]*runs-on:')" -eq 1 ] \
  && ok "t12 exactly one job" \
  || bad "t12 exactly one job"
expect_contains     "t13 pinned runner generation ubuntu-24.04" "$WF_TEXT" "runs-on: ubuntu-24.04"
expect_not_contains "t14 no floating ubuntu-latest"             "$WF_TEXT" "ubuntu-latest"
[ "$(count_matches '^[[:space:]]*timeout-minutes: 10$')" -eq 1 ] \
  && ok "t15 job timeout is exactly 10 minutes (measured-suite budget)" \
  || bad "t15 job timeout is exactly 10 minutes (measured-suite budget)"

# Concurrency: cancel superseded PR runs only; dispatch runs queued.
expect_contains "t16 concurrency group set" "$WF_TEXT" "group: harness-"
expect_contains "t17 cancellation limited to pull_request" \
  "$WF_TEXT" "cancel-in-progress: \${{ github.event_name == 'pull_request' }}"

# Action references: full commit SHAs only, version comments documented.
USES_TOTAL="$(count_matches '^[[:space:]]*uses:')"
USES_SHA="$(count_matches '^[[:space:]]*uses: [A-Za-z0-9_-]+/[A-Za-z0-9._-]+@[0-9a-f]{40}')"
[ -n "$USES_TOTAL" ] && [ "$USES_TOTAL" -ge 2 ] \
  && ok "t18 uses: references found ($USES_TOTAL)" \
  || bad "t18 uses: references found (got: $USES_TOTAL)"
[ "$USES_TOTAL" -eq "$USES_SHA" ] \
  && ok "t19 every uses: reference is a full 40-char commit SHA" \
  || bad "t19 every uses: reference is a full 40-char commit SHA (total: $USES_TOTAL, sha: $USES_SHA)"
[ "$(count_matches '^[[:space:]]*uses: .*@v[0-9]')" -eq 0 ] \
  && ok "t20 no @vN tag references" \
  || bad "t20 no @vN tag references"
[ "$(count_matches '^[[:space:]]*uses: [A-Za-z0-9_-]+/[A-Za-z0-9._-]+@[0-9a-f]{40} +# ')" -eq "$USES_SHA" ] \
  && ok "t21 every pinned action carries a version comment" \
  || bad "t21 every pinned action carries a version comment"
expect_not_contains "t22 no floating latest refs" "$WF_TEXT" "@latest"

# Same pinning convention as the Core/E2E workflows (identical pinned
# SHAs).
for pin in \
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" \
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"; do
  expect_contains "t23 pinned action shared with Core/E2E workflows: $pin" "$WF_TEXT" "$pin"
done
expect_contains "t24 checkout pin matches standalone core workflow" \
  "$(cat "$CORE_WF")" "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
expect_contains "t25 setup-node pin matches standalone e2e workflow" \
  "$(cat "$E2E_WF")" "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"

# Clean CI-safe execution contract.
expect_contains     "t26 checkout with persist-credentials: false" "$WF_TEXT" "persist-credentials: false"
[ "$(count_matches '^[[:space:]]*node-version: 24$')" -eq 1 ] \
  && ok "t27 Node 24 per the repository contract (single setup)" \
  || bad "t27 Node 24 per the repository contract (single setup)"
expect_not_contains "t28 no npm ci"              "$WF_TEXT" "npm ci"
expect_not_contains "t29 no npm install"         "$WF_TEXT" "npm install"
expect_not_contains "t30 no npm run gate command" "$WF_TEXT" "npm run "
expect_not_contains "t31 no uv sync"             "$WF_TEXT" "uv sync"
expect_not_contains "t32 no setup-uv action"     "$WF_TEXT" "setup-uv"
# No PostgreSQL service.
expect_not_contains "t33 no services block"      "$WF_TEXT" "services:"
expect_not_contains "t34 no postgres image"      "$WF_TEXT" "postgres"
expect_not_contains "t35 no pg_isready healthcheck" "$WF_TEXT" "pg_isready"
expect_not_contains "t36 no 5432 port mapping"   "$WF_TEXT" "5432"
# No browser.
expect_not_contains "t37 no Playwright reference" "$WF_TEXT" "playwright"
expect_not_contains "t38 no chromium reference"   "$WF_TEXT" "chromium"
# No Docker.
expect_not_contains "t39 no docker build"    "$WF_TEXT" "docker build"
expect_not_contains "t40 no buildx"          "$WF_TEXT" "buildx"
expect_not_contains "t41 no docker/ actions" "$WF_TEXT" "docker/"
expect_not_contains "t42 no GHCR reference"  "$WF_TEXT" "ghcr"

# Canonical invocation: exactly one, the runner; the suite list is not
# duplicated in the workflow.
[ "$(grep -Fc 'bash scripts/tests/harness-contracts.test.sh' "$WF")" -eq 1 ] \
  && ok "t43 exactly one canonical Harness runner invocation" \
  || bad "t43 exactly one canonical Harness runner invocation"
for suite in \
  "agent-verify.test.sh" \
  "core-workflow.test.sh" \
  "e2e-workflow.test.sh" \
  "publish-workflow.test.sh" \
  "harness-workflow.test.sh" \
  "agent-doctor.test.sh"; do
  expect_not_contains "t44 no suite-list duplication: $suite" "$WF_TEXT" "$suite"
done

# No artifact contract for this fast textual gate.
expect_not_contains "t45 no artifact upload action" "$WF_TEXT" "upload-artifact"
expect_not_contains "t46 no retention configuration" "$WF_TEXT" "retention-days"
expect_not_contains "t47 no artifacts context"       "$WF_TEXT" "artifacts:"

# No bypasses or branch-protection configuration.
[ "$(count_matches 'always\(\)')" -eq 0 ] \
  && ok "t48 no unprotected always() anywhere in the workflow" \
  || bad "t48 no unprotected always() anywhere in the workflow"
expect_not_contains "t49 no branch protection configuration" "$WF_TEXT" "branch_protection"

# Optional: full GitHub-semantic lint when actionlint is installed.
if command -v actionlint >/dev/null 2>&1; then
  AOUT="$(actionlint "$WF" 2>&1)" && ok "t50 actionlint: no issues" \
    || { bad "t50 actionlint: no issues"; printf '%s\n' "$AOUT"; }
else
  printf 'skip t50 actionlint (not installed; GitHub-semantic validation not available here)\n'
fi

# ------------------------------------------------------------- summary ----
printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf 'harness-workflow tests: PASS (%d checks)\n' "$PASS"
  exit 0
fi
printf 'harness-workflow tests: FAIL (%d failed, %d passed)\n' "$FAIL" "$PASS"
printf 'failed: %s\n' "${FAILED[*]}"
exit 1
