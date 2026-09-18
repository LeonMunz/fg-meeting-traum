#!/usr/bin/env bash
# verify.sh — case-specific verifier for the pilot case
# `activity-feed-query-cost`.
#
# Usage:
#   bash verify.sh AGENT_WORKSPACE_DIR
#
# Behavior:
#   1. validates the agent workspace (exists, is a directory, is a git
#      repo, has no remote, has exactly one baseline commit with the
#      expected baseline tree, has no access to the fix commit object,
#      and contains no control/acceptance files);
#   2. SECURES the measured agent diff (git status --short, full diff
#      against the baseline commit, diff stat) BEFORE running checks;
#   3. builds a PRIVATE verification copy of the agent's work state
#      (untracked files included, .git excluded) and copies ONLY the
#      hidden acceptance test into it;
#   4. runs the hidden acceptance test and the existing Activity feed
#      regression tests there, using only the isolated Django test
#      database;
#   5. proves the agent workspace itself was never modified.
#
# This script NEVER modifies the agent workspace and never applies or
# implements any patch/solution.
#
# Control-flow contract:
#   - BOTH test groups (hidden acceptance, existing Activity feed
#     regression tests) run within the SAME verifier invocation.
#   - A domain failure of the hidden acceptance does NOT skip the
#     regression tests, and vice versa.
#   - Each group's result is reported unambiguously as PASS / FAIL /
#     ERROR (ERROR = could not be executed: infrastructure/setup).
#   - Baseline identity is pinned to the single ROOT commit and its
#     tree: additional agent commits on top of the baseline are
#     accepted; HEAD is NOT required to be the baseline commit.
#
# Exit codes — priority: infrastructure > hidden acceptance >
# regression > success. An infrastructure failure is NEVER masked by
# exit code 4 or 5:
#   0  both test groups executed reliably and both PASSED
#   1  usage error (missing/invalid argument)
#   2  agent workspace failed structural or leakage checks (no tests
#      executed)
#   3  verifier infrastructure error: private copy, acceptance
#      injection, dependency/setup failure, a test group could not be
#      started or its run could not be evaluated, the Django setup
#      check failed, or workspace non-mutation could not be confirmed
#   4  both test groups were executable; hidden acceptance failed on
#      domain grounds (also when the regression tests fail on domain
#      grounds as well)
#   5  both test groups were executable; hidden acceptance passed but
#      the regression tests failed on domain grounds
#
# A normally started Django run with failed assertions or test
# ERRORs caused by the code under test is a domain result (FAIL),
# not an infrastructure error; ERROR means the group could not be
# reliably started, prepared, or evaluated by the verifier.
set -uo pipefail

CASE_ID="activity-feed-query-cost"
# Baseline tree hash of the start commit in the control repository.
BASELINE_TREE="4f6105e4a70c3221a75cc73898ff03445f7ccbe1"
START_COMMIT="336bf466d8f1e8a9531f1e1bfd68d156c17cf0b3"
REFERENCE_FIX_COMMIT="e4736b272a5d5154b9dd0fb1b068b73d8bfdef2e"
HIDDEN_ACCEPTANCE_REL="acceptance/test_activity_feed_query_cost.py"
# The hidden test is copied into the private verification copy under a
# case-specific module name (no collision with agent-written files).
HIDDEN_TARGET_FILE="test_eval_hidden_query_cost.py"
HIDDEN_MODULE="audit_history.test_eval_hidden_query_cost"
REGRESSION_MODULES="audit_history.tests_activity_feed audit_history.tests_activity_feed_meetings"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
ACCEPTANCE_FILE="$SCRIPT_DIR/$HIDDEN_ACCEPTANCE_REL"

REPORT_DIR=""
VERIFY_DIR=""
WS=""

cleanup() {
  # Only remove temporary directories THIS process created with
  # mktemp -d and validated. The report dir is kept as evidence.
  if [[ -n "$VERIFY_DIR" && -d "$VERIFY_DIR" ]]; then
    rm -rf -- "$VERIFY_DIR"
  fi
}
trap cleanup EXIT

fail_usage() { echo "verify.sh: usage: bash verify.sh AGENT_WORKSPACE_DIR" >&2; exit 1; }
fail_ws() { echo "verify.sh: WORKSPACE CHECK FAILED: $*" >&2; exit 2; }
fail_infra() { echo "verify.sh: INFRASTRUCTURE/SETUP FAILURE: $*" >&2; exit 3; }

section() { echo; echo "=== $* ==="; }

# Classify a Django test-run log: prints PASS / TESTS_FAILED / INFRA.
classify_test_log() {
  local log="$1"
  if grep -qE '^FAILED([ (]|$)' "$log"; then
    echo "TESTS_FAILED"
  elif grep -qE '^OK([ (]|$)' "$log"; then
    echo "PASS"
  else
    echo "INFRA"
  fi
}

# --- usage ------------------------------------------------------------------
[[ $# -eq 1 ]] || fail_usage
WS="${1}"
[[ -n "$WS" ]] || fail_usage

# --- [1/5] snapshot / leakage check ------------------------------------------
section "[1/5] SNAPSHOT / LEAKAGE CHECK (agent workspace: $WS)"
if [[ ! -e "$WS" ]]; then
  fail_ws "path does not exist: $WS"
fi
if [[ ! -d "$WS" ]]; then
  fail_ws "not a directory: $WS"
fi
WS="$(cd -- "$WS" && pwd -P)"
if ! git -C "$WS" rev-parse --git-dir >/dev/null 2>&1; then
  fail_ws "not a git repository: $WS"
fi

if [[ -n "$(git -C "$WS" remote)" ]]; then
  fail_ws "workspace must have no remote (found: $(git -C "$WS" remote | tr '\n' ' '))."
fi

ROOT_COMMITS="$(git -C "$WS" rev-list --max-parents=0 HEAD)"
ROOT_COUNT="$(printf '%s\n' "$ROOT_COMMITS" | grep -c .)"
if [[ "$ROOT_COUNT" -ne 1 ]]; then
  fail_ws "expected exactly one baseline (root) commit, found ${ROOT_COUNT}."
fi
ROOT_SHA="$(printf '%s\n' "$ROOT_COMMITS" | head -n1)"
ROOT_TREE="$(git -C "$WS" rev-parse "${ROOT_SHA}^{tree}")"
if [[ "$ROOT_TREE" != "$BASELINE_TREE" ]]; then
  fail_ws "baseline tree mismatch: expected ${BASELINE_TREE}, got ${ROOT_TREE}."
fi
echo "ok: exactly one baseline commit (root tree ${ROOT_TREE})."

if git -C "$WS" cat-file -e "${REFERENCE_FIX_COMMIT}^{commit}" 2>/dev/null; then
  fail_ws "reference fix commit object is reachable in the workspace."
fi
echo "ok: reference fix commit object NOT reachable."
if git -C "$WS" cat-file -e "${START_COMMIT}^{commit}" 2>/dev/null; then
  fail_ws "original start commit object is reachable in the workspace."
fi
echo "ok: original start commit object NOT reachable."

if [[ -d "$WS/evals" ]]; then
  fail_ws "evals/ directory present in workspace."
fi
if [[ -e "$WS/task.md" || -e "$WS/control.md" ]]; then
  fail_ws "task.md/control.md present at workspace root."
fi
if FOUND_HIDDEN="$(find "$WS" -name 'test_activity_feed_query_cost.py' -not -path '*/.git/*' 2>/dev/null)" && [[ -n "$FOUND_HIDDEN" ]]; then
  fail_ws "hidden acceptance file name present in workspace: $FOUND_HIDDEN"
fi
echo "ok: no control/acceptance files in workspace."

# --- [2/5] secure the measured diff BEFORE anything else --------------------
section "[2/5] SECURE MEASURED DIFF"
REPORT_DIR="$(mktemp -d)" || fail_infra "cannot create report dir."
git -C "$WS" status --short  > "$REPORT_DIR/agent-git-status-short.txt"
git -C "$WS" diff "$ROOT_SHA" > "$REPORT_DIR/agent-diff-vs-baseline.patch"
git -C "$WS" diff --stat "$ROOT_SHA" > "$REPORT_DIR/agent-diff-stat.txt"
PRE_HEAD="$(git -C "$WS" rev-parse HEAD)"
cp -- "$REPORT_DIR/agent-git-status-short.txt" "$REPORT_DIR/agent-git-status-before.txt"
echo "ok: status/diff secured in $REPORT_DIR"
echo "    (untracked files appear in the status file, not in the diff)."

# --- [3/5] private verification copy + setup --------------------------------
section "[3/5] PRIVATE VERIFICATION COPY + SETUP"
VERIFY_DIR="$(mktemp -d)" || fail_infra "cannot create verification dir."
COPY_DIR="$VERIFY_DIR/agent-copy"
mkdir -p -- "$COPY_DIR"
# Full agent work state including untracked files, WITHOUT its .git.
if ! tar -C "$WS" --exclude '.git' -cf - . | tar -x -C "$COPY_DIR"; then
  fail_infra "copying the agent work state failed."
fi
APP_DIR="$COPY_DIR/apps/api"
if [[ ! -d "$APP_DIR/audit_history" || ! -f "$APP_DIR/manage.py" ]]; then
  fail_infra "copied workspace is not a valid backend checkout (apps/api missing)."
fi
# Copy ONLY the hidden acceptance test into the private copy.
cp -- "$ACCEPTANCE_FILE" "$APP_DIR/audit_history/$HIDDEN_TARGET_FILE" \
  || fail_infra "hidden acceptance file missing from the case package."
# Setup gate: the Django project must boot in the private copy.
if ! (cd "$APP_DIR" && uv run python manage.py check) > "$REPORT_DIR/setup-check.log" 2>&1; then
  tail -n 20 "$REPORT_DIR/setup-check.log" >&2
  fail_infra "Django system check failed in the private verification copy (see $REPORT_DIR/setup-check.log)."
fi
echo "ok: private verification copy ready (no .git, hidden test staged)."

# --- [4/5] hidden acceptance --------------------------------------------------
section "[4/5] HIDDEN ACCEPTANCE (query-cost invariance)"
(cd "$APP_DIR" && uv run python manage.py test "$HIDDEN_MODULE" -v 2) \
  > "$REPORT_DIR/hidden-acceptance.log" 2>&1
HIDDEN_RC=$?
HIDDEN_STATUS="$(classify_test_log "$REPORT_DIR/hidden-acceptance.log")"
tail -n 25 "$REPORT_DIR/hidden-acceptance.log"
case "$HIDDEN_STATUS" in
  PASS)         echo "RESULT: hidden acceptance = PASS" ;;
  TESTS_FAILED) echo "RESULT: hidden acceptance = FAIL (domain failure, exit ${HIDDEN_RC})" ;;
  *)            echo "RESULT: hidden acceptance = ERROR (could not be executed, exit ${HIDDEN_RC})" ;;
esac
# No exit here: the regression tests must run in the same invocation,
# even when the hidden acceptance fails.

# --- [5/5] existing Activity feed regression tests ---------------------------
section "[5/5] EXISTING ACTIVITY FEED REGRESSION TESTS"
(cd "$APP_DIR" && uv run python manage.py test $REGRESSION_MODULES) \
  > "$REPORT_DIR/existing-regression.log" 2>&1
REG_RC=$?
REG_STATUS="$(classify_test_log "$REPORT_DIR/existing-regression.log")"
tail -n 15 "$REPORT_DIR/existing-regression.log"
case "$REG_STATUS" in
  PASS)         echo "RESULT: regression tests = PASS" ;;
  TESTS_FAILED) echo "RESULT: regression tests = FAIL (domain failure, exit ${REG_RC})" ;;
  *)            echo "RESULT: regression tests = ERROR (could not be executed, exit ${REG_RC})" ;;
esac

# --- non-mutation proof + overall status -------------------------------------
section "AGENT WORKSPACE NON-MUTATION CHECK"
git -C "$WS" status --short > "$REPORT_DIR/agent-git-status-after.txt"
POST_HEAD="$(git -C "$WS" rev-parse HEAD)"
if diff -q -- "$REPORT_DIR/agent-git-status-before.txt" "$REPORT_DIR/agent-git-status-after.txt" >/dev/null \
   && [[ "$PRE_HEAD" == "$POST_HEAD" ]]; then
  echo "ok: agent workspace unmodified (status and HEAD identical before/after)."
else
  echo "FAIL: agent workspace changed during verification (see status before/after files)."
  section "OVERALL STATUS: ERROR (workspace mutated during verification)"
  echo "evidence dir (kept): $REPORT_DIR"
  exit 3
fi

section "OVERALL RESULT SUMMARY"
echo "case: $CASE_ID"
echo "agent workspace: $WS"
echo "baseline commit (root): $ROOT_SHA"
echo "hidden acceptance: ${HIDDEN_STATUS}"
echo "regression tests:  ${REG_STATUS}"
echo "evidence dir (kept): $REPORT_DIR"
echo "verification copy: removed (was $VERIFY_DIR)"

# Final exit-code mapping, priority: infrastructure > hidden
# acceptance > regression > success. If either test group could not
# be executed reliably, the whole eval run is INVALID and ends as an
# infrastructure error — never as a regular agent failure (4/5).
if [[ "$HIDDEN_STATUS" == "INFRA" || "$REG_STATUS" == "INFRA" ]]; then
  section "OVERALL STATUS: ERROR (infrastructure/setup failure — run invalid)"
  exit 3
fi
if [[ "$HIDDEN_STATUS" == "TESTS_FAILED" ]]; then
  if [[ "$REG_STATUS" == "TESTS_FAILED" ]]; then
    section "OVERALL STATUS: FAIL (hidden acceptance + regression tests)"
  else
    section "OVERALL STATUS: FAIL (hidden acceptance)"
  fi
  exit 4
fi
if [[ "$REG_STATUS" == "TESTS_FAILED" ]]; then
  section "OVERALL STATUS: FAIL (regression tests)"
  exit 5
fi
section "OVERALL STATUS: PASS"
exit 0
