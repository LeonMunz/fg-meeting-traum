#!/usr/bin/env bash
#
# Static contract tests for the CI production image publication
# workflow (.github/workflows/publish-images.yml).
#
# Run:  bash scripts/tests/publish-workflow.test.sh
#
# Requires: bash + grep only (plus actionlint, if installed, for a
# full GitHub-semantic lint pass). No new dependencies are introduced:
# the checks below are the security- and contract-critical invariants
# of the publication workflow, not a second full copy of it.
#
# Coverage:
#   * workflow file exists
#   * the ONLY trigger is workflow_run on the canonical Core workflow,
#     referenced by its exact top-level `name:` value (read from
#     core.yml), and nothing else (no pull_request/push/
#     workflow_dispatch/schedule/...) — automatic publication is a push
#     to main, and only through the core gate
#   * permissions are exactly contents: read + packages: write (no
#     id-token, no other write scope, no actions scope)
#   * exactly two jobs (publish-api, publish-web), pinned ubuntu
#     generation, bounded timeouts
#   * both jobs run only after a SUCCESSFUL core run of a push to main
#     (conclusion/event/head_branch job condition on every job)
#   * every uses: reference is a full 40-char commit SHA with a version
#     comment; the checkout pin is shared with the core workflow; no
#     @vN/@latest/@main references
#   * the checkout is the core run's head SHA with a revision-verify
#     step (the checkout must not silently build another revision); the
#     production image identity is the core run's head SHA — plain
#     github.sha is never used for it
#   * GHCR login via GITHUB_TOKEN only (the only secret referenced)
#   * both production Dockerfiles are referenced with their existing
#     build contexts (apps/api for the API image, repository root for
#     the web image); no Compose build
#   * platform contract: linux/amd64 on both jobs (the documented
#     VServer target) and no other platform
#   * the full 40-char Git SHA (core run head SHA) is the ONLY tag on
#     both jobs (no mutable tag such as latest is published anywhere in
#     the workflow)
#   * image repository names: no unsupported expression-level
#     lowercasing, no hardcoded owner/repository; lowercasing happens
#     in an executable runtime Bash step writing the image reference to
#     GITHUB_OUTPUT; the API image ends in -api and the web image ends
#     in -web; tag/labels/report all consume that step output
#   * standard OCI source/revision labels on both images
#   * the production Compose topology remains compatible: it still
#     requires FG_WEB_IMAGE/FG_API_IMAGE and hardcodes no image name
#   * no branch-protection configuration
#   * actionlint (when installed) reports no issues
#
# Not covered here (no YAML library / actionlint in the agent sandbox):
# full YAML syntax and GitHub-semantic validation. These run in CI
# (GitHub parses the workflow) and wherever actionlint is available.

set -Eeuo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WF="$REPO_ROOT/.github/workflows/publish-images.yml"
CORE_WF="$REPO_ROOT/.github/workflows/core.yml"
COMPOSE="$REPO_ROOT/deploy/compose.production.yaml"

PASS=0
FAIL=0
FAILED=()

ok()   { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); FAILED+=("$1"); printf 'FAIL %s\n' "$1"; }

expect_exists() { # expect_exists <name> <file>
  if [ -f "$2" ]; then ok "$1"; else bad "$1 (missing: $2)"; fi
}

expect_contains() { # expect_contains <name> <haystack> <literal-needle>
  case "$2" in
    *"$3"*) ok "$1" ;;
    *) bad "$1 (missing: $3)" ;;
  esac
}

expect_not_contains() { # expect_not_contains <name> <haystack> <literal-needle>
  case "$2" in
    *"$3"*) bad "$1 (found: $3)" ;;
    *) ok "$1" ;;
  esac
}

line_count() { # line_count <ERE> <file> -> number of matching lines
  grep -Ec "$1" "$2" 2>/dev/null || true
}

fixed_count() { # fixed_count <literal> <file> -> number of matching lines
  grep -Fce "$1" "$2" 2>/dev/null || true
}

expect_line_count() { # expect_line_count <name> <want> <ERE> <file>
  local got
  got="$(line_count "$3" "$4")"
  if [ "$got" -eq "$2" ]; then ok "$1"; else bad "$1 (want $2 lines, got $got)"; fi
}

expect_fixed_count() { # expect_fixed_count <name> <want> <literal> <file>
  local got
  got="$(fixed_count "$3" "$4")"
  if [ "$got" -eq "$2" ]; then ok "$1"; else bad "$1 (want $2 lines, got $got)"; fi
}

# --------------------------------------------------------- structure ------
expect_exists "t01 workflow file exists" "$WF"
[ -f "$WF" ] || { printf 'publish-workflow tests: FAIL (no workflow file)\n'; exit 1; }
expect_exists "t02 core gate workflow exists" "$CORE_WF"

WF_TEXT="$(cat "$WF")"
COMPOSE_TEXT="$(cat "$COMPOSE")"

# The canonical Core workflow's exact top-level name: value (structural,
# read from the gate file itself — not a second copy).
CORE_NAME="$(grep -m1 -E '^name: ' "$CORE_WF" | sed 's/^name: //')"
[ -n "$CORE_NAME" ] || { printf 'publish-workflow tests: FAIL (no core workflow name)\n'; exit 1; }

# Trigger: exactly workflow_run on the Core workflow BY NAME, completed,
# and nothing else.
expect_line_count "t03 trigger workflow_run present" 1 '^  workflow_run:' "$WF"
expect_fixed_count "t04 workflow_run depends on the exact Core workflow name" 1 \
  "workflows: [\"$CORE_NAME\"]" "$WF"
expect_contains   "t05 gate completion event" "$WF_TEXT" "types: [completed]"
for trig in pull_request pull_request_target push workflow_dispatch schedule release repository_dispatch deployment; do
  expect_line_count "t06 no trigger: $trig" 0 "^  ${trig}:" "$WF"
done

# Permissions: exactly contents read + packages write.
expect_line_count "t07 permissions contents: read" 1  '^  contents: read' "$WF"
expect_line_count "t08 permissions packages: write" 1 '^  packages: write' "$WF"
expect_not_contains "t09 no id-token permission" "$WF_TEXT" "id-token:"
expect_line_count "t10 exactly one write scope (packages)" 1 '^  [a-z-]+: write$' "$WF"

# Two jobs, pinned runner generation, bounded timeouts.
expect_line_count "t11 exactly two jobs (api + web)" 2 '^[[:space:]]*runs-on:' "$WF"
expect_line_count "t12 both jobs on pinned ubuntu-24.04" 2 '^[[:space:]]*runs-on: ubuntu-24\.04$' "$WF"
expect_not_contains "t13 no floating ubuntu-latest" "$WF_TEXT" "ubuntu-latest"
expect_line_count "t14 both jobs have bounded timeouts" 2 '^[[:space:]]*timeout-minutes: [0-9]+$' "$WF"

# Publication only after a successful core gate run of a push to main.
for cond in \
  "github.event.workflow_run.conclusion == 'success'" \
  "github.event.workflow_run.event == 'push'" \
  "github.event.workflow_run.head_branch == 'main'"; do
  expect_fixed_count "t15 gate condition on both jobs" 2 "$cond" "$WF"
done

# Action references: full commit SHAs only, version comments documented.
USES_TOTAL="$(line_count '^[[:space:]]*uses:' "$WF")"
USES_SHA="$(line_count '^[[:space:]]*uses: [A-Za-z0-9_-]+/[A-Za-z0-9._-]+@[0-9a-f]{40}' "$WF")"
[ "$USES_TOTAL" -ge 8 ] \
  && ok "t16 uses: references found ($USES_TOTAL)" \
  || bad "t16 uses: references found (got: $USES_TOTAL)"
[ "$USES_TOTAL" -eq "$USES_SHA" ] \
  && ok "t17 every uses: reference is a full 40-char commit SHA" \
  || bad "t17 every uses: reference is a full 40-char commit SHA (total: $USES_TOTAL, sha: $USES_SHA)"
expect_line_count "t18 no @vN tag references" 0 '^[[:space:]]*uses: .*@v[0-9]' "$WF"
[ "$(line_count '^[[:space:]]*uses: [A-Za-z0-9_-]+/[A-Za-z0-9._-]+@[0-9a-f]{40} +# ' "$WF")" -eq "$USES_SHA" ] \
  && ok "t19 every pinned action carries a version comment" \
  || bad "t19 every pinned action carries a version comment"
expect_not_contains "t20 no floating latest refs" "$WF_TEXT" "@latest"
expect_not_contains "t21 no floating main refs"    "$WF_TEXT" "@main"

# Same checkout pin as the core/e2e workflows (identical pinned SHA).
expect_contains "t22 checkout pin shared with the core workflow" \
  "$WF_TEXT" "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"

# Source revision integrity: the production image identity is the core
# run's head SHA — checked out, verified, and tagged. Plain github.sha
# (the workflow_run's own HEAD) is never the image identity.
expect_line_count "t23 publish SHA env is the core run head SHA (both jobs)" 2 \
  '^[[:space:]]*FG_PUBLISH_SHA: \$\{\{ github.event.workflow_run.head_sha \}\}$' "$WF"
# Comment lines are stripped for this check: a comment may MENTION the
# token, but an executable expression may not use it (the tag/SHA
# contract itself is pinned structurally by t23 + t40/t41).
WF_NONCOMMENT_TEXT="$(sed -e 's/^[[:space:]]*#.*$//' "$WF")"
expect_not_contains "t24 no plain github.sha as production image identity" "$WF_NONCOMMENT_TEXT" "github.sha"
expect_line_count "t25 checkout ref is the core run head SHA (both jobs)" 2 \
  '^[[:space:]]*ref: \$\{\{ github.event.workflow_run.head_sha \}\}$' "$WF"
expect_line_count "t26 checkout with persist-credentials: false (both jobs)" 2 \
  '^[[:space:]]*persist-credentials: false$' "$WF"
expect_fixed_count "t27 revision-verify step on both jobs" 2 \
  'test "$(git rev-parse HEAD)" = "$FG_PUBLISH_SHA"' "$WF"

# Authentication: GHCR via GITHUB_TOKEN only.
expect_line_count "t28 GHCR login on both jobs" 2 '^[[:space:]]*registry: ghcr\.io$' "$WF"
expect_line_count "t29 GITHUB_TOKEN is the login credential (both jobs)" 2 \
  '^[[:space:]]*password: \$\{\{ secrets.GITHUB_TOKEN \}\}$' "$WF"
expect_fixed_count "t30 no secret besides GITHUB_TOKEN is referenced" 2 'secrets.' "$WF"

# Build sources: the existing production Dockerfiles with their existing
# build contexts; no Compose build of application images.
expect_line_count "t31 API image context is apps/api" 1 '^[[:space:]]*context: apps/api$' "$WF"
expect_contains     "t32 API Dockerfile referenced" "$WF_TEXT" "file: apps/api/Dockerfile"
expect_line_count "t33 web image context is the repository root" 1 '^[[:space:]]*context: \.$' "$WF"
expect_contains     "t34 web Dockerfile referenced" "$WF_TEXT" "file: apps/web/Dockerfile"
expect_not_contains "t35 no Compose build of application images" "$WF_TEXT" "docker compose"
expect_not_contains "t36 no docker-compose build" "$WF_TEXT" "docker-compose"
expect_line_count "t37 both jobs push to the registry" 2 '^[[:space:]]*push: true$' "$WF"

# Platform contract: linux/amd64 (the documented VServer target), only.
expect_line_count "t38 both jobs build linux/amd64" 2 '^[[:space:]]*platforms: linux/amd64$' "$WF"
expect_line_count "t39 no other platform is built" 2 '^[[:space:]]*platforms:' "$WF"

# Tag contract: the derived image name tagged with the full core-run
# head SHA; no mutable tag anywhere.
expect_line_count "t40 both jobs tag <derived-name>:<full head SHA>" 2 \
  '^[[:space:]]*tags: \$\{\{ steps.image.outputs.name \}\}:\$\{\{ env.FG_PUBLISH_SHA \}\}$' "$WF"
expect_line_count "t41 no extra tag input" 2 '^[[:space:]]*tags:' "$WF"
expect_not_contains "t42 no latest tag anywhere" "$WF_TEXT" ":latest"
expect_not_contains "t43 no branch tag anywhere" "$WF_TEXT" ":main"

# Lowercase image names: no unsupported expression-level lowercasing, no
# hardcoded owner/repository; lowercasing happens in an executable
# runtime Bash step on the runner.
# (The needle is assembled from parts so this test file itself never
# contains the unsupported expression text.)
TOLOWER_NEEDLE="toLo""wer("
expect_not_contains "t44 no unsupported expression-level lowercasing" "$WF_TEXT" "$TOLOWER_NEEDLE"
expect_line_count "t45 no hardcoded lowercase owner/repository in any ghcr.io path" 0 \
  'ghcr\.io/[a-z0-9_-]+/[a-z0-9._-]+' "$WF"
expect_line_count "t46 runtime derive step on both jobs" 2 '^[[:space:]]*id: image$' "$WF"
expect_fixed_count "t47 runtime lowercasing in a Bash step (both jobs)" 2 \
  'repository="${GH_REPOSITORY,,}"' "$WF"
expect_line_count "t48 derive step reads github.repository via env (both jobs)" 2 \
  '^[[:space:]]*GH_REPOSITORY: \$\{\{ github.repository \}\}$' "$WF"
expect_fixed_count "t49 derive step writes GITHUB_OUTPUT (both jobs)" 2 \
  '>> "$GITHUB_OUTPUT"' "$WF"
expect_fixed_count "t50 API image reference ends in -api" 1 \
  'echo "name=ghcr.io/${repository}-api" >> "$GITHUB_OUTPUT"' "$WF"
expect_fixed_count "t51 web image reference ends in -web" 1 \
  'echo "name=ghcr.io/${repository}-web" >> "$GITHUB_OUTPUT"' "$WF"

# The derived step output is the single source for tag, labels, report.
expect_fixed_count "t52 OCI source label on both images" 2 'org.opencontainers.image.source=' "$WF"
expect_fixed_count "t53 OCI revision label on both images" 2 'org.opencontainers.image.revision=' "$WF"
expect_contains "t54 revision label carries the publish SHA" \
  "$WF_TEXT" "org.opencontainers.image.revision=\${{ env.FG_PUBLISH_SHA }}"
expect_fixed_count "t55 OCI repos label uses the derived image name (both jobs)" 2 \
  'org.opencontainers.image.repos=${{ steps.image.outputs.name }}' "$WF"
expect_fixed_count "t56 publication report uses the derived image name (both jobs)" 2 \
  'PUBLISHED_IMAGE: ${{ steps.image.outputs.name }}' "$WF"

# Compose compatibility: the topology still consumes the images through
# the required variables and hardcodes no image name.
expect_contains "t57 compose still requires FG_WEB_IMAGE" "$COMPOSE_TEXT" 'FG_WEB_IMAGE:?FG_WEB_IMAGE is required'
expect_contains "t58 compose still requires FG_API_IMAGE" "$COMPOSE_TEXT" 'FG_API_IMAGE:?FG_API_IMAGE is required'
expect_not_contains "t59 compose hardcodes no GHCR image name" "$COMPOSE_TEXT" "ghcr.io"

# No branch-protection configuration in the workflow.
expect_not_contains "t60 no branch protection configuration" "$WF_TEXT" "branch_protection"

# Optional: full GitHub-semantic lint when actionlint is installed.
if command -v actionlint >/dev/null 2>&1; then
  AOUT="$(actionlint "$WF" 2>&1)" && ok "t61 actionlint: no issues" \
    || { bad "t61 actionlint: no issues"; printf '%s\n' "$AOUT"; }
else
  printf 'skip t61 actionlint (not installed; GitHub-semantic validation not available here)\n'
fi

# ------------------------------------------------------------- summary ----
printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf 'publish-workflow tests: PASS (%d checks)\n' "$PASS"
  exit 0
fi
printf 'publish-workflow tests: FAIL (%d failed, %d passed)\n' "$FAIL" "$PASS"
printf 'failed: %s\n' "${FAILED[*]}"
exit 1
