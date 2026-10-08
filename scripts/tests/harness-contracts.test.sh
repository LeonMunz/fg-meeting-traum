#!/usr/bin/env bash
#
# Canonical fast Harness / CI contract suite (clean-checkout-safe).
#
# Run:  bash scripts/tests/harness-contracts.test.sh
#
# This runner is the single CI entrypoint for the fast Harness contract
# suite. Both the standalone Harness workflow (.github/workflows/harness.yml)
# and the embedded `harness` job of the release DAG
# (.github/workflows/publish-images.yml) invoke EXACTLY this runner; the
# individual suite list lives here and nowhere else — in particular not
# in workflow YAML.
#
# Suite contents, executed in this deterministic order (fail-fast):
#   1. agent-verify     — agent-verify.sh contract tests (usage, plan mode,
#                         --summary-json contract)
#   2. core-workflow    — CI Core workflow static contract (core.yml)
#   3. e2e-workflow     — CI E2E workflow static contract (e2e.yml)
#   4. publish-workflow — CI release DAG static contract (publish-images.yml)
#   5. harness-workflow — CI Harness workflow static contract (harness.yml)
#
# Contract: dependency-light and CLEAN-CHECKOUT-SAFE — bash plus node
# (node only for JSON validation inside the agent-verify suite). No
# installs, no browser, no PostgreSQL, no Docker, no network after
# checkout, no mutation of the working tree, no retries, no parallelism.
#
# Deliberately NOT in this suite (different runtime/environment concerns;
# exclusion is a CI-capability decision, not a coverage judgment):
#   * agent-doctor.test.sh — the doctor contract is a BROADER
#     provisioned-environment contract (some scenarios require installed
#     frontend dependencies, the backend .venv, an installed Playwright
#     Chromium, and a reachable PostgreSQL); it remains a valid local /
#     Living-Lab test and is not part of this clean CI gate.
#   * agent-observability.test.sh, agent-product-launch.test.sh,
#     postgres-backup-restore.test.sh, production-api-image.test.sh,
#     production-compose.test.sh, release-transaction.test.sh —
#     host-dependent suites (Docker daemon, ACP host integration,
#     production image builds) that may only join a gate with matching
#     CI capability in their own slice.

set -Eeuo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Fail-fast sequential execution: the first failing suite stops the
# runner with a non-zero exit code (no retries, no parallelism). The
# per-suite output (ok/FAIL lines + summary) streams through unchanged.
for suite in \
  agent-verify \
  core-workflow \
  e2e-workflow \
  publish-workflow \
  harness-workflow; do
  printf '\n=== harness-contracts: %s ===\n' "$suite"
  if ! bash "$REPO_ROOT/scripts/tests/${suite}.test.sh"; then
    printf '\nharness-contracts: FAIL (suite: %s)\n' "$suite"
    exit 1
  fi
done

printf '\nharness-contracts: PASS (all 5 suites)\n'
