#!/usr/bin/env bash
# prepare.sh — case-specific snapshot generator for the pilot case
# `activity-feed-query-cost`.
#
# Creates a fresh, isolated single-commit agent workspace from the
# historical start commit of the control repository:
#
#   bash prepare.sh             # target is a fresh mktemp -d directory
#   bash prepare.sh TARGET_DIR  # refuse if TARGET_DIR already exists
#
# Guarantees:
#   - The control repository is NEVER modified (read-only git only).
#   - The workspace carries the start commit's tree only: exactly one
#     branch, exactly one commit, no remote, no tags, no stashes, and
#     no access to any other git object (fresh `git init`, no
#     --reference/--shared, the original .git is never copied).
#   - A generic, non-personal local git identity is used.
#   - No task.md / control.md / acceptance / verifier files enter the
#     workspace.
#   - Existing directories are never deleted or overwritten.
#
# Exit codes: 0 = workspace created and verified; 1 = refused/failed.
set -euo pipefail

CASE_ID="activity-feed-query-cost"
START_COMMIT="336bf466d8f1e8a9531f1e1bfd68d156c17cf0b3"
BRANCH_NAME="main"
GIT_IDENTITY_NAME="FG Eval Baseline"
GIT_IDENTITY_EMAIL="eval-baseline@localhost"

die() {
  echo "prepare.sh: ERROR: $*" >&2
  exit 1
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." >/dev/null 2>&1 && pwd -P)"

# --- control repository sanity (read-only) -------------------------------
git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 \
  || die "$REPO_ROOT is not a git repository."
git -C "$REPO_ROOT" cat-file -e "${START_COMMIT}^{commit}" 2>/dev/null \
  || die "start commit ${START_COMMIT} not present in the control repository."

# --- target selection ------------------------------------------------------
CREATED_BY_US=0
TARGET=""
if [[ $# -eq 1 ]]; then
  TARGET="$1"
  if [[ -z "$TARGET" ]]; then
    die "TARGET_DIR must not be empty."
  fi
  # Refuse a pre-existing target in ANY form — file, directory, or
  # symlink (including broken ones) — before touching it.
  if [[ -e "$TARGET" || -L "$TARGET" ]]; then
    die "target already exists: $TARGET (refusing to overwrite)."
  fi
  mkdir -p -- "$(dirname -- "$TARGET")"
  # Create the target itself for this run: mkdir without -p fails if
  # anything (re)appears at the path before this point, so the script
  # never writes into a target it did not create itself.
  if ! mkdir -- "$TARGET"; then
    die "target already exists: $TARGET (refusing to overwrite)."
  fi
  CREATED_BY_US=1
elif [[ $# -gt 0 ]]; then
  die "usage: bash prepare.sh [TARGET_DIR]"
else
  TARGET="$(mktemp -d)"
  CREATED_BY_US=1
fi

# Remove a target created BY THIS RUN (mktemp or explicit TARGET_DIR)
# only when this script FAILS; on success the snapshot is the product
# and is kept. A target that pre-existed the run is refused above and
# never touched at all.
cleanup_on_failure() {
  local rc=$?
  if [[ $rc -ne 0 && $CREATED_BY_US -eq 1 && -n "$TARGET" && -d "$TARGET" ]]; then
    rm -rf -- "$TARGET"
  fi
}
trap cleanup_on_failure EXIT

# --- materialize the start commit's tree (never the original .git) --------
git -C "$REPO_ROOT" archive "$START_COMMIT" | tar -x -C "$TARGET"
[[ ! -e "$TARGET/.git" ]] || die "original .git found in snapshot (must not happen)."

# --- fresh repository: one branch, one commit, no remote ------------------
git -C "$TARGET" init -q -b "$BRANCH_NAME"
git -C "$TARGET" config user.name "$GIT_IDENTITY_NAME"
git -C "$TARGET" config user.email "$GIT_IDENTITY_EMAIL"
git -C "$TARGET" config core.hooksPath .git/hooks
# Force-add: the archive contains exactly the files tracked at the
# start commit; -f guarantees the baseline tree is reproduced 1:1
# regardless of any .gitignore patterns.
git -C "$TARGET" add -fA
git -C "$TARGET" -c commit.gpgsign=false commit -q \
  -m "Baseline snapshot for eval case ${CASE_ID}"

# --- self-verification of the isolation contract ---------------------------
EXPECTED_TREE="$(git -C "$REPO_ROOT" rev-parse "${START_COMMIT}^{tree}")"
ACTUAL_TREE="$(git -C "$TARGET" rev-parse 'HEAD^{tree}')"
[[ "$ACTUAL_TREE" == "$EXPECTED_TREE" ]] \
  || die "baseline tree mismatch: expected ${EXPECTED_TREE}, got ${ACTUAL_TREE}."

COMMIT_COUNT="$(git -C "$TARGET" rev-list --count HEAD)"
[[ "$COMMIT_COUNT" -eq 1 ]] || die "expected exactly 1 commit, found ${COMMIT_COUNT}."

[[ -z "$(git -C "$TARGET" remote)" ]] || die "workspace must have no remote."
[[ -z "$(git -C "$TARGET" tag)" ]] || die "workspace must have no tags."
[[ -z "$(git -C "$TARGET" stash list)" ]] || die "workspace must have no stashes."
BRANCH_COUNT="$(git -C "$TARGET" branch --format='%(refname:short)' | wc -l | tr -d ' ')"
[[ "$BRANCH_COUNT" -eq 1 ]] || die "expected exactly 1 branch, found ${BRANCH_COUNT}."

# No control/acceptance/verifier files may exist in the workspace.
for forbidden in evals task.md control.md test_activity_feed_query_cost.py prepare.sh verify.sh; do
  if [[ -e "$TARGET/$forbidden" ]]; then
    die "forbidden path present in snapshot: $forbidden"
  fi
done

# On success the snapshot is the product: the EXIT trap only removes
# the target on failure (rc != 0), so we simply leave it in place.
BASELINE_COMMIT="$(git -C "$TARGET" rev-parse HEAD)"

echo "eval-case: ${CASE_ID}"
echo "snapshot-path: ${TARGET}"
echo "baseline-commit: ${BASELINE_COMMIT}"
echo "branch: ${BRANCH_NAME}"
echo "commits: ${COMMIT_COUNT}"
echo "remotes: none"
echo "tags: none"
echo "stashes: none"
echo "control-files-in-snapshot: none"
