#!/usr/bin/env bash
# prepare.test.sh — contract test for the target-directory behavior of
# the pilot case's prepare.sh (control-side test; never enters the
# candidate workspace).
#
# Usage:
#   bash evals/cases/activity-feed-query-cost/tests/prepare.test.sh
#
# No product database, no browser, and no network connection required.
#
# Contract under test:
#   1.  An explicit, previously non-existent target path works (parent
#       path created as needed).
#   2.  The emitted snapshot path equals the requested path exactly.
#   3.  A target path containing spaces works.
#   4.  A pre-existing EMPTY directory is refused.
#   5.  A pre-existing NON-EMPTY directory is refused and its sentinel
#       file stays byte-identical.
#   6.  A pre-existing FILE is refused and stays unchanged.
#   7.  A SYMLINK target is refused; neither the symlink nor its link
#       target is modified.
#   8.  No-argument mode (self-created mktemp target) still works.
#   9.  Every successful workspace: clean working tree, exactly one
#       root/baseline commit, the expected baseline tree, exactly one
#       local branch, no remotes/tags/stashes, no reachable
#       historical fix or original start commit object, and no
#       evals/ / control.md / acceptance/.
#   10. The control repository is unchanged before and after EVERY
#       prepare.sh invocation.
#
# Exit codes: 0 = all checks passed; 1 = at least one check failed.
set -uo pipefail

CASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
PREPARE="$CASE_DIR/prepare.sh"
REPO_ROOT="$(cd -- "$CASE_DIR/../../.." >/dev/null 2>&1 && pwd -P)"

# Case-pinned constants (mirroring the case's control metadata).
BASELINE_TREE="4f6105e4a70c3221a75cc73898ff03445f7ccbe1"
START_COMMIT="336bf466d8f1e8a9531f1e1bfd68d156c17cf0b3"
REFERENCE_FIX_COMMIT="e4736b272a5d5154b9dd0fb1b068b73d8bfdef2e"

FAILURES=0
CHECKS=0
NOARG_TARGET=""

pass() { CHECKS=$((CHECKS + 1)); echo "ok   - $*"; }
fail() { CHECKS=$((CHECKS + 1)); FAILURES=$((FAILURES + 1)); echo "FAIL - $*" >&2; }

# check <0|1> <label>   (0 = success)
# Callers must pass an explicit "0" or "1" (never a bare command
# substitution that could expand to empty and shift the arguments).
check() {
  if [[ $# -lt 2 || ( "$1" != "0" && "$1" != "1" ) ]]; then
    fail "malformed check invocation (args: $*)"
    return
  fi
  if [[ "$1" -eq 0 ]]; then pass "$2"; else fail "$2"; fi
}

WORK_ROOT="$(mktemp -d)" || { echo "FATAL: cannot create work root" >&2; exit 1; }

cleanup() {
  local p
  for p in "$WORK_ROOT" "$NOARG_TARGET"; do
    if [[ -n "$p" && ( -e "$p" || -L "$p" ) ]]; then
      if ! rm -rf -- "$p" 2>/dev/null; then
        echo "cleanup: could not remove (left in place): $p" >&2
      fi
    fi
  done
}
trap cleanup EXIT

# Read-only fingerprint of the control repository.
control_snapshot() {
  {
    git -C "$REPO_ROOT" rev-parse HEAD
    git -C "$REPO_ROOT" status --porcelain
    git -C "$REPO_ROOT" for-each-ref
    git -C "$REPO_ROOT" stash list
  } 2>/dev/null
}

# run_prepare <label> [args...]
# Runs prepare.sh, captures stdout/stderr/exit code, and verifies the
# control repository is byte-identical (git state) around the run.
OUT=""
ERR=""
RC=0
run_prepare() {
  local label="$1"
  shift
  local before after
  before="$(control_snapshot)"
  OUT="$(bash "$PREPARE" "$@" 2>"$WORK_ROOT/err.txt")"
  RC=$?
  ERR="$(cat "$WORK_ROOT/err.txt" 2>/dev/null)"
  after="$(control_snapshot)"
  if [[ "$before" == "$after" ]]; then
    check 0 "case ${label}: control repository unchanged across the prepare.sh run"
  else
    check 1 "case ${label}: control repository unchanged across the prepare.sh run"
  fi
}

snapshot_path_of() {
  printf '%s\n' "$1" | sed -n 's/^snapshot-path: //p' | tail -n 1
}

# Full isolation invariants for a successful candidate workspace.
check_workspace() {
  local label="$1" ws="$2"
  check $([[ -d "$ws" && ! -L "$ws" ]] && echo 0 || echo 1) \
    "case ${label}: workspace exists and is a real directory"
  check $([[ "$(git -C "$ws" rev-parse --is-inside-work-tree 2>/dev/null)" == "true" ]] && echo 0 || echo 1) \
    "case ${label}: workspace is a git work tree"
  check $([[ -z "$(git -C "$ws" status --porcelain 2>/dev/null)" ]] && echo 0 || echo 1) \
    "case ${label}: clean working tree"
  check $([[ "$(git -C "$ws" rev-list --count HEAD 2>/dev/null)" == "1" ]] && echo 0 || echo 1) \
    "case ${label}: exactly one commit"
  check $([[ "$(git -C "$ws" rev-list --max-parents=0 --count HEAD 2>/dev/null)" == "1" ]] && echo 0 || echo 1) \
    "case ${label}: exactly one root (baseline) commit"
  check $([[ "$(git -C "$ws" rev-parse 'HEAD^{tree}' 2>/dev/null)" == "$BASELINE_TREE" ]] && echo 0 || echo 1) \
    "case ${label}: baseline tree is the expected ${BASELINE_TREE}"
  check $([[ "$(git -C "$ws" branch --format='%(refname)' 2>/dev/null)" == "refs/heads/main" ]] && echo 0 || echo 1) \
    "case ${label}: exactly one local branch (main)"
  check $([[ -z "$(git -C "$ws" remote 2>/dev/null)" ]] && echo 0 || echo 1) \
    "case ${label}: no remotes"
  check $([[ -z "$(git -C "$ws" tag 2>/dev/null)" ]] && echo 0 || echo 1) \
    "case ${label}: no tags"
  check $([[ -z "$(git -C "$ws" stash list 2>/dev/null)" ]] && echo 0 || echo 1) \
    "case ${label}: no stashes"
  if git -C "$ws" cat-file -e "${REFERENCE_FIX_COMMIT}^{commit}" 2>/dev/null; then
    check 1 "case ${label}: historical fix commit object NOT reachable"
  else
    check 0 "case ${label}: historical fix commit object NOT reachable"
  fi
  if git -C "$ws" cat-file -e "${START_COMMIT}^{commit}" 2>/dev/null; then
    check 1 "case ${label}: original start commit object NOT reachable"
  else
    check 0 "case ${label}: original start commit object NOT reachable"
  fi
  check $([[ ! -e "$ws/evals" ]] && echo 0 || echo 1) \
    "case ${label}: no evals/ in workspace"
  check $([[ ! -e "$ws/control.md" ]] && echo 0 || echo 1) \
    "case ${label}: no control.md in workspace"
  check $([[ ! -e "$ws/acceptance" ]] && echo 0 || echo 1) \
    "case ${label}: no acceptance/ in workspace"
}

echo "=== prepare.test.sh: target-directory contract for ${CASE_DIR##*/} ==="

# --- case 1: explicit, previously non-existent target path ---------------
T1="$WORK_ROOT/case1/nested/afqc-target"
run_prepare "1" "$T1"
check $([[ "$RC" -eq 0 ]] && echo 0 || echo 1) \
  "case 1: prepare.sh <non-existent explicit target> exits 0"
check $([[ -d "$T1" && ! -L "$T1" ]] && echo 0 || echo 1) \
  "case 1: target exists afterwards and is a real directory (not a symlink)"

# --- case 2: emitted target equals the requested path exactly ------------
SP1="$(snapshot_path_of "$OUT")"
check $([[ -n "$SP1" && "$SP1" == "$T1" ]] && echo 0 || echo 1) \
  "case 2: emitted snapshot-path equals the requested path exactly"
check_workspace "1" "$T1"

# --- case 3: target path containing spaces --------------------------------
T3="$WORK_ROOT/case 3/target with spaces"
run_prepare "3" "$T3"
check $([[ "$RC" -eq 0 ]] && echo 0 || echo 1) \
  "case 3: prepare.sh <target path with spaces> exits 0"
SP3="$(snapshot_path_of "$OUT")"
check $([[ "$SP3" == "$T3" ]] && echo 0 || echo 1) \
  "case 3: emitted snapshot-path equals the requested spaced path exactly"
check_workspace "3" "$T3"

# --- case 4: pre-existing EMPTY directory is refused ----------------------
T4="$WORK_ROOT/case4"
mkdir -p -- "$T4"
run_prepare "4" "$T4"
check $([[ "$RC" -eq 1 ]] && echo 0 || echo 1) \
  "case 4: pre-existing empty directory is refused (exit 1)"
check $([[ "$ERR" == *"refusing"* ]] && echo 0 || echo 1) \
  "case 4: refusal reported on stderr"
check $([[ -d "$T4" && "$(find "$T4" -mindepth 1 | wc -l | tr -d ' ')" == "0" ]] && echo 0 || echo 1) \
  "case 4: pre-existing empty directory still exists and remains empty"

# --- case 5: pre-existing NON-EMPTY directory is refused ------------------
T5="$WORK_ROOT/case5"
mkdir -p -- "$T5"
printf 'afqc-sentinel\n' > "$T5/sentinel.txt"
cp -- "$T5/sentinel.txt" "$WORK_ROOT/sentinel.before"
run_prepare "5" "$T5"
check $([[ "$RC" -eq 1 ]] && echo 0 || echo 1) \
  "case 5: pre-existing non-empty directory is refused (exit 1)"
check $([[ "$ERR" == *"refusing"* ]] && echo 0 || echo 1) \
  "case 5: refusal reported on stderr"
check $( [[ -f "$T5/sentinel.txt" ]] && cmp -s "$T5/sentinel.txt" "$WORK_ROOT/sentinel.before" && echo 0 || echo 1 ) \
  "case 5: sentinel file remains byte-identical"
check $([[ "$(find "$T5" -mindepth 1 | wc -l | tr -d ' ')" == "1" ]] && echo 0 || echo 1) \
  "case 5: nothing added to or removed from the pre-existing directory"

# --- case 6: pre-existing FILE is refused and unchanged -------------------
T6="$WORK_ROOT/case6"
printf 'afqc-file-sentinel\n' > "$T6"
cp -- "$T6" "$WORK_ROOT/file.before"
run_prepare "6" "$T6"
check $([[ "$RC" -eq 1 ]] && echo 0 || echo 1) \
  "case 6: pre-existing file is refused (exit 1)"
check $([[ "$ERR" == *"refusing"* ]] && echo 0 || echo 1) \
  "case 6: refusal reported on stderr"
check $( [[ -f "$T6" ]] && cmp -s "$T6" "$WORK_ROOT/file.before" && echo 0 || echo 1 ) \
  "case 6: pre-existing file remains byte-identical"

# --- case 7: SYMLINK target is refused -------------------------------------
T7_LINKDIR="$WORK_ROOT/case7-linktarget"
mkdir -p -- "$T7_LINKDIR"
printf 'afqc-linktarget-data\n' > "$T7_LINKDIR/inside.txt"
cp -- "$T7_LINKDIR/inside.txt" "$WORK_ROOT/inside.before"
T7="$WORK_ROOT/case7"
ln -s -- "$T7_LINKDIR" "$T7"
run_prepare "7" "$T7"
check $([[ "$RC" -eq 1 ]] && echo 0 || echo 1) \
  "case 7: symlink target is refused (exit 1)"
check $([[ "$ERR" == *"refusing"* ]] && echo 0 || echo 1) \
  "case 7: refusal reported on stderr"
check $([[ -L "$T7" && "$(readlink "$T7")" == "$T7_LINKDIR" ]] && echo 0 || echo 1) \
  "case 7: symlink still exists and points to the same target"
check $( cmp -s "$T7_LINKDIR/inside.txt" "$WORK_ROOT/inside.before" && echo 0 || echo 1 ) \
  "case 7: link target file remains byte-identical"
check $([[ "$(find "$T7_LINKDIR" -mindepth 1 | wc -l | tr -d ' ')" == "1" ]] && echo 0 || echo 1) \
  "case 7: nothing added to or removed from the link target directory"
# broken-symlink variant: must also be refused, and stay a broken symlink
T7B="$WORK_ROOT/case7-broken"
ln -s -- "$WORK_ROOT/does-not-exist" "$T7B"
run_prepare "7b" "$T7B"
check $([[ "$RC" -eq 1 ]] && echo 0 || echo 1) \
  "case 7b: broken symlink target is refused (exit 1)"
check $([[ -L "$T7B" && ! -e "$T7B" ]] && echo 0 || echo 1) \
  "case 7b: broken symlink still exists and is still broken"

# --- case 8: no-argument mode still works ----------------------------------
run_prepare "8"
check $([[ "$RC" -eq 0 ]] && echo 0 || echo 1) \
  "case 8: prepare.sh with no argument exits 0"
NOARG_TARGET="$(snapshot_path_of "$OUT")"
check $([[ -n "$NOARG_TARGET" && -d "$NOARG_TARGET" ]] && echo 0 || echo 1) \
  "case 8: self-created target exists and is reported"
check_workspace "8" "$NOARG_TARGET"

# --- summary ----------------------------------------------------------------
echo
echo "checks: ${CHECKS}, failures: ${FAILURES}"
if [[ "$FAILURES" -gt 0 ]]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
