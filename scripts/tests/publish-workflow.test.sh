#!/usr/bin/env bash
#
# Static contract tests for the CI production release DAG
# (.github/workflows/publish-images.yml).
#
# Run:  bash scripts/tests/publish-workflow.test.sh
#
# Requires: bash + grep + awk only (plus actionlint, if installed, for a
# full GitHub-semantic lint pass). No new dependencies are introduced:
# the checks below are the security- and contract-critical invariants of
# the release DAG, not a second full copy of it.
#
# Topology under test (single same-SHA release DAG for push to main):
#
#   push main @ X  ->  ONE workflow run with five jobs:
#                       core      (canonical Core verification)
#                       e2e       (canonical Playwright E2E)
#                       harness   (canonical fast Harness contract suite)
#                       publish-api (needs: [core, e2e, harness])
#                       publish-web (needs: [core, e2e, harness])
#   github.sha == X is the authoritative publication SHA; there is no
#   cross-workflow correlation and no completion-order race.
#
# Coverage:
#   * workflow file exists; name is `Production image publication (GHCR)`
#   * the ONLY trigger is push to main (no workflow_run, no
#     pull_request, no workflow_dispatch, no schedule/...), and no
#     github.event.* expression remains anywhere in the workflow
#   * permissions: workflow level exactly contents: read + packages:
#     write (no id-token, no other write scope); the embedded gate jobs
#     narrow their job-level permissions to contents: read
#   * exactly five jobs (core, e2e, harness, publish-api, publish-web);
#     pinned ubuntu-24.04 (no ubuntu-latest); bounded timeouts (core
#     45 min; e2e + both publication jobs 20 min; harness 10 min)
#   * both publication jobs depend on ALL THREE gate jobs (needs: core
#     + e2e + harness — checked semantically, independent of list
#     formatting); no always() bypass anywhere
#   * the embedded harness job preserves the canonical fast Harness
#     contract runner invocation (identical to the standalone harness
#     workflow) with the clean CI-safe setup: Node 24 only, no
#     dependency installation, no database, no browser, no Docker,
#     narrowed read-only permissions, 10-minute budget
#   * the embedded core job preserves the canonical core verification
#     invocation (agent-verify core profile, --summary-json target in
#     runner temp, postgres:16 health-checked service, 45-minute budget,
#     non-browser setup, standard summary artifact)
#   * the embedded e2e job preserves the canonical E2E invocation and
#     the reset safety contract (FG_ALLOW_E2E_RESET exactly once, on
#     the canonical gate line; chromium-only browser install; standard
#     summary/failure artifacts)
#   * the publication SHA derives from github.sha (both jobs), the
#     checkout uses that same SHA, and the checked-out-HEAD equality
#     assertion remains on both jobs
#   * every uses: reference is a full 40-char commit SHA with a version
#     comment; the checkout pin is shared with the standalone gate
#     workflows; no @vN/@latest/@main references
#   * GHCR login via GITHUB_TOKEN only (the only secret referenced)
#   * both production Dockerfiles are referenced with their existing
#     build contexts (apps/api for the API image, repository root for
#     the web image); no Compose build
#   * platform contract: linux/amd64 on both publication jobs, only
#   * the full 40-char Git SHA (github.sha) is the ONLY tag on both
#     jobs (no mutable tag such as latest is published anywhere)
#   * image repository names: no unsupported expression-level
#     lowercasing, no hardcoded owner/repository; lowercasing happens
#     in an executable runtime Bash step writing the image reference to
#     GITHUB_OUTPUT; the API image ends in -api and the web image ends
#     in -web; tag/labels/report all consume that step output
#   * standard OCI source/revision labels on both images
#   * main-run concurrency: the release DAG is queued and never
#     cancelled (cancel-in-progress: false; no queue: max)
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
E2E_WF="$REPO_ROOT/.github/workflows/e2e.yml"
HARNESS_WF="$REPO_ROOT/.github/workflows/harness.yml"
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

needs_of() { # needs_of <job-key> -> one dependency per line (any YAML
# list formatting: block list, flow list, or single value)
  awk -v job="$1" '
    /^  [A-Za-z0-9_-]+:$/ { injob = ($0 == "  " job ":"); next }
    injob && /^[[:space:]]+needs:/ {
      val = $0
      sub(/^[[:space:]]*needs:[[:space:]]*/, "", val)
      if (val ~ /^\[/) {
        gsub(/[\[\]]/, " ", val)
        n = split(val, parts, /[ ,]+/)
        for (i = 1; i <= n; i++) if (parts[i] != "") print parts[i]
        exit
      } else if (val != "") {
        print val
        exit
      } else {
        while ((getline l) > 0) {
          if (l ~ /^[[:space:]]+-[[:space:]]/) {
            v = l
            sub(/^[[:space:]]*-[[:space:]]*/, "", v)
            print v
          } else {
            break
          }
        }
        exit
      }
    }
  ' "$WF"
}

needs_norm() { # needs_norm <job-key> -> sorted, space-joined deps
  needs_of "$1" | sort | tr '\n' ' '
}

# --------------------------------------------------------- structure ------
expect_exists "t01 workflow file exists" "$WF"
[ -f "$WF" ] || { printf 'publish-workflow tests: FAIL (no workflow file)\n'; exit 1; }
expect_exists "t02 standalone core gate workflow exists" "$CORE_WF"
expect_exists "t03 standalone e2e gate workflow exists" "$E2E_WF"
expect_exists "t03 standalone harness gate workflow exists" "$HARNESS_WF"

WF_TEXT="$(cat "$WF")"
COMPOSE_TEXT="$(cat "$COMPOSE")"

# Workflow identity.
expect_fixed_count "t04 workflow name unchanged" 1 \
  "name: Production image publication (GHCR)" "$WF"

# Trigger: exactly push to main, and nothing else.
expect_line_count "t05 trigger push present" 1 '^  push:$' "$WF"
expect_line_count "t06 exactly one branch filter, [main]" 1 \
  '^[[:space:]]*branches: \[main\]$' "$WF"
for trig in workflow_run pull_request workflow_dispatch pull_request_target \
            schedule release repository_dispatch deployment push_tag; do
  expect_line_count "t07 no trigger: $trig" 0 "^  ${trig}:" "$WF"
done
# No cross-workflow publication coordination remains (neither an
# expression nor any mention in comments).
expect_not_contains "t08 no workflow_run coordination remains" "$WF_TEXT" "workflow_run"
expect_not_contains "t09 no github.event.* expression remains" "$WF_TEXT" "github.event"

# Permissions: workflow level exactly contents read + packages write;
# the embedded gate jobs narrow to contents read.
expect_line_count "t10 workflow-level permissions contents: read" 1 '^  contents: read$' "$WF"
expect_line_count "t11 workflow-level permissions packages: write" 1 '^  packages: write$' "$WF"
expect_not_contains "t12 no id-token permission" "$WF_TEXT" "id-token:"
expect_line_count "t13 exactly one workflow-level write scope (packages)" 1 \
  '^  [a-z-]+: write$' "$WF"
expect_line_count "t14 exactly three job-level permissions blocks (the gate jobs)" 3 \
  '^    permissions:$' "$WF"
expect_line_count "t15 gate jobs narrow to contents: read (all three)" 3 \
  '^      contents: read$' "$WF"
expect_line_count "t16 no job-level write scope" 0 '^      [a-z-]+: write$' "$WF"

# Exactly the four intended jobs.
JOB_KEYS="$(awk '/^jobs:$/{inj=1; next} inj && /^  [A-Za-z0-9_-]+:$/{print $0}' "$WF")"
[ "$(printf '%s\n' "$JOB_KEYS" | grep -c .)" -eq 5 ] \
  && ok "t17 exactly five jobs under jobs:" \
  || bad "t17 exactly five jobs under jobs: (got: $(printf '%s' "$JOB_KEYS" | tr '\n' ' '))"
for key in core e2e harness publish-api publish-web; do
  expect_line_count "t18 job key present exactly once: $key" 1 "^  ${key}:" "$WF"
done
expect_fixed_count "t19 visible gate job name: Core verification" 1 \
  "name: Core verification" "$WF"
expect_fixed_count "t19 visible gate job name: Playwright E2E (chromium)" 1 \
  "name: Playwright E2E (chromium)" "$WF"
expect_fixed_count "t19 visible gate job name: Harness contracts" 1 \
  "name: Harness contracts" "$WF"

# Runners + timeouts: four jobs, pinned generation, bounded budgets.
expect_line_count "t20 exactly five jobs run (runs-on lines)" 5 '^[[:space:]]*runs-on:' "$WF"
expect_line_count "t20 all jobs on pinned ubuntu-24.04" 5 '^[[:space:]]*runs-on: ubuntu-24\.04$' "$WF"
expect_not_contains "t21 no floating ubuntu-latest" "$WF_TEXT" "ubuntu-latest"
expect_line_count "t22 core gate keeps the 45-minute budget" 1 \
  '^[[:space:]]*timeout-minutes: 45$' "$WF"
expect_line_count "t22 e2e + both publication jobs keep 20-minute budgets" 3 \
  '^[[:space:]]*timeout-minutes: 20$' "$WF"
expect_line_count "t22 harness gate keeps the 10-minute budget" 1 \
  '^[[:space:]]*timeout-minutes: 10$' "$WF"

# Publication is declaratively gated on BOTH gate jobs of THIS run.
expect_line_count "t23 needs: declared exactly twice (the publication jobs)" 2 \
  '^[[:space:]]+needs:' "$WF"
[ "$(needs_norm publish-api)" = "core e2e harness " ] \
  && ok "t24 publish-api needs exactly [core, e2e, harness] (semantic)" \
  || bad "t24 publish-api needs exactly [core, e2e, harness] (semantic) (got: $(needs_norm publish-api))"
[ "$(needs_norm publish-web)" = "core e2e harness " ] \
  && ok "t25 publish-web needs exactly [core, e2e, harness] (semantic)" \
  || bad "t25 publish-web needs exactly [core, e2e, harness] (semantic) (got: $(needs_norm publish-web))"
expect_line_count "t26 no always() bypass anywhere" 0 'always\(' "$WF"

# Publication SHA: github.sha of the push-triggered run, both jobs.
expect_line_count "t27 publish SHA env is github.sha (both jobs)" 2 \
  '^[[:space:]]*FG_PUBLISH_SHA: \$\{\{ github\.sha \}\}$' "$WF"
expect_line_count "t28 checkout ref is github.sha (both jobs)" 2 \
  '^[[:space:]]*ref: \$\{\{ github\.sha \}\}$' "$WF"
expect_line_count "t29 checkout with persist-credentials: false (all five jobs)" 5 \
  '^[[:space:]]*persist-credentials: false$' "$WF"
expect_fixed_count "t30 checked-out-HEAD equality assertion (both publication jobs)" 2 \
  'test "$(git rev-parse HEAD)" = "$FG_PUBLISH_SHA"' "$WF"

# Embedded canonical core gate: same invocation, service, and evidence
# contract as the standalone core workflow.
expect_line_count "t31 postgres pinned to repo major version 16 (both gate jobs)" 2 \
  '^[[:space:]]*image: postgres:16$' "$WF"
expect_line_count "t32 postgres healthcheck via pg_isready (both gate jobs)" 2 'pg_isready' "$WF"
expect_line_count "t33 postgres port mapping 5432:5432 (both gate jobs)" 2 '5432:5432' "$WF"
# The only gate invocations in the whole workflow: one core, one e2e.
# The publication jobs re-run no test suite.
expect_line_count "t34 exactly two canonical agent-verify invocations" 2 \
  'scripts/agent-verify\.sh \\$' "$WF"
expect_fixed_count "t35 embedded core summary-json target in runner temp" 1 \
  '--summary-json "$RUNNER_TEMP/fg-core/core-summary.json"' "$WF"
expect_fixed_count "t35 standalone core workflow carries the identical target" 1 \
  '--summary-json "$RUNNER_TEMP/fg-core/core-summary.json"' "$CORE_WF"
expect_line_count "t36 core profile argument present exactly once" 1 \
  '^[[:space:]]*core$' "$WF"
expect_fixed_count "t37 core summary target directory prepared" 1 \
  'mkdir -p "$RUNNER_TEMP/fg-core"' "$WF"
expect_fixed_count "t38 core artifact name deterministic per run id + attempt" 1 \
  'name: core-summary-${{ github.run_id }}-${{ github.run_attempt }}' "$WF"
# The core job stays non-browser: no browser install/test step inside its
# job block (the single chromium install lives in the e2e job).
CORE_JOB_BLOCK="$(awk '/^  core:$/{inj=1} /^  [A-Za-z0-9_-]+:$/ && !/^  core:$/{if (inj) exit} inj' "$WF")"
if [ -n "$CORE_JOB_BLOCK" ] \
    && ! printf '%s\n' "$CORE_JOB_BLOCK" | grep -qi 'playwright install' \
    && ! printf '%s\n' "$CORE_JOB_BLOCK" | grep -qi 'playwright test'; then
  ok "t39 core job stays non-browser (no browser install/test step in its job block)"
else
  bad "t39 core job stays non-browser (no browser install/test step in its job block)"
fi

# Embedded canonical E2E gate: same invocation and reset safety contract.
expect_fixed_count "t40 canonical E2E invocation (FG_ALLOW_E2E_RESET + agent-verify)" 1 \
  'FG_ALLOW_E2E_RESET=1 ./scripts/agent-verify.sh' "$WF"
expect_fixed_count "t41 embedded e2e summary-json target in runner temp" 1 \
  '--summary-json "$RUNNER_TEMP/fg-e2e/e2e-summary.json"' "$WF"
expect_fixed_count "t41 standalone e2e workflow carries the identical target" 1 \
  '--summary-json "$RUNNER_TEMP/fg-e2e/e2e-summary.json"' "$E2E_WF"
expect_line_count "t42 e2e profile argument present exactly once" 1 \
  '^[[:space:]]*e2e$' "$WF"
expect_line_count "t43 FG_ALLOW_E2E_RESET appears exactly once (reset safety)" 1 \
  'FG_ALLOW_E2E_RESET' "$WF"
GATE_LINE="$(grep 'FG_ALLOW_E2E_RESET' "$WF" || true)"
case "$GATE_LINE" in
  *"./scripts/agent-verify.sh"*) ok "t44 FG_ALLOW_E2E_RESET sits on the canonical gate line" ;;
  *) bad "t44 FG_ALLOW_E2E_RESET sits on the canonical gate line" ;;
esac
expect_fixed_count "t45 e2e summary target directory prepared" 1 \
  'mkdir -p "$RUNNER_TEMP/fg-e2e"' "$WF"
expect_line_count "t46 e2e artifact names deterministic per run id + attempt" 2 \
  'e2e-(summary|failure)-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}' "$WF"

# Embedded canonical Harness gate: the same canonical fast contract
# runner as the standalone harness workflow, with the clean CI-safe
# setup (Node 24 only; no database, no browser, no Docker, no
# dependency installation).
expect_line_count "t46a embedded harness invokes the canonical runner exactly once" 1 \
  'bash scripts/tests/harness-contracts\.test\.sh' "$WF"
expect_line_count "t46a standalone harness workflow carries the identical runner" 1 \
  'bash scripts/tests/harness-contracts\.test\.sh' "$HARNESS_WF"
expect_line_count "t46a no individual suite list duplication in the release DAG" 0 \
  'scripts/tests/(agent-verify|core-workflow|e2e-workflow|publish-workflow|harness-workflow)\.test\.sh' "$WF"
HARNESS_JOB_BLOCK="$(awk '/^  harness:$/{inj=1} /^  [A-Za-z0-9_-]+:$/ && !/^  harness:$/{if (inj) exit} inj' "$WF")"
if [ -n "$HARNESS_JOB_BLOCK" ] \
    && ! printf '%s\n' "$HARNESS_JOB_BLOCK" | grep -q 'npm ci\|npm install\|uv sync\|setup-uv' \
    && ! printf '%s\n' "$HARNESS_JOB_BLOCK" | grep -qi 'playwright\|chromium\|postgres\|5432' \
    && ! printf '%s\n' "$HARNESS_JOB_BLOCK" | grep -qi 'buildx\|docker build\|ghcr'; then
  ok "t46b harness job block stays CI-safe (no install, no database, no browser, no Docker)"
else
  bad "t46b harness job block stays CI-safe (no install, no database, no browser, no Docker)"
fi

# Reproducible setup contract (shared by both embedded gate jobs).
expect_contains     "t47 checkout with persist-credentials: false" "$WF_TEXT" "persist-credentials: false"
expect_contains     "t47 npm ci is the JS install"                  "$WF_TEXT" "npm ci"
expect_line_count   "t47 npm ci only in the two product gate jobs (harness installs nothing)" 2 \
  '^[[:space:]]*run: npm ci$' "$WF"
expect_not_contains "t47 no npm install"                             "$WF_TEXT" "npm install"
expect_line_count   "t47 uv sync --frozen in both gate jobs (no lockfile update)" 2 \
  '^[[:space:]]*run: uv sync --frozen$' "$WF"
expect_line_count   "t47 Node 24 in all three gate jobs" 3 \
  '^[[:space:]]*node-version: 24$' "$WF"
expect_fixed_count  "t48 playwright chromium install with deps (e2e job only)" 1 \
  'npx playwright install --with-deps chromium' "$WF"
expect_line_count   "t48 no playwright test call" 0 'playwright test' "$WF"
expect_not_contains "t49 no direct npm run gate command" "$WF_TEXT" "npm run "
expect_not_contains "t49 no direct Django manage.py gate" "$WF_TEXT" "manage.py"

# Action references: full commit SHAs only, version comments documented.
USES_TOTAL="$(line_count '^[[:space:]]*uses:' "$WF")"
USES_SHA="$(line_count '^[[:space:]]*uses: [A-Za-z0-9_-]+/[A-Za-z0-9._-]+@[0-9a-f]{40}' "$WF")"
[ "$USES_TOTAL" -eq 19 ] \
  && ok "t50 exactly 19 uses: references (4 core + 5 e2e + 2 harness + 4 + 4 publish)" \
  || bad "t50 exactly 19 uses: references (4 core + 5 e2e + 2 harness + 4 + 4 publish) (got: $USES_TOTAL)"
[ "$USES_TOTAL" -eq "$USES_SHA" ] \
  && ok "t51 every uses: reference is a full 40-char commit SHA" \
  || bad "t51 every uses: reference is a full 40-char commit SHA (total: $USES_TOTAL, sha: $USES_SHA)"
expect_line_count "t52 no @vN tag references" 0 '^[[:space:]]*uses: .*@v[0-9]' "$WF"
[ "$(line_count '^[[:space:]]*uses: [A-Za-z0-9_-]+/[A-Za-z0-9._-]+@[0-9a-f]{40} +# ' "$WF")" -eq "$USES_SHA" ] \
  && ok "t53 every pinned action carries a version comment" \
  || bad "t53 every pinned action carries a version comment"
expect_not_contains "t54 no floating latest refs" "$WF_TEXT" "@latest"
expect_not_contains "t55 no floating main refs"   "$WF_TEXT" "@main"
# Same checkout pin as the standalone gate workflows (identical SHA).
expect_line_count "t56 checkout pin used by all five jobs" 5 \
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' "$WF"
expect_line_count "t56 setup-node pin used by all three gate jobs" 3 \
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020' "$WF"
expect_contains "t56 checkout pin shared with the standalone core workflow" \
  "$(cat "$CORE_WF")" "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
expect_contains "t56 checkout pin shared with the standalone e2e workflow" \
  "$(cat "$E2E_WF")" "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"

# Authentication: GHCR via GITHUB_TOKEN only — the only secret referenced.
expect_line_count "t57 GHCR login on both publication jobs" 2 \
  '^[[:space:]]*registry: ghcr\.io$' "$WF"
expect_line_count "t58 GITHUB_TOKEN is the login credential (both jobs)" 2 \
  '^[[:space:]]*password: \$\{\{ secrets\.GITHUB_TOKEN \}\}$' "$WF"
SECRET_KINDS="$(grep -Eo 'secrets\.[A-Za-z_]+' "$WF" | sort -u)"
[ "$SECRET_KINDS" = "secrets.GITHUB_TOKEN" ] \
  && ok "t59 no secret besides GITHUB_TOKEN is referenced" \
  || bad "t59 no secret besides GITHUB_TOKEN is referenced (got: $SECRET_KINDS)"

# Build sources: the existing production Dockerfiles with their existing
# build contexts; no Compose build of application images.
expect_line_count "t61 API image context is apps/api" 1 '^[[:space:]]*context: apps/api$' "$WF"
expect_contains     "t62 API Dockerfile referenced" "$WF_TEXT" "file: apps/api/Dockerfile"
expect_line_count "t63 web image context is the repository root" 1 '^[[:space:]]*context: \.$' "$WF"
expect_contains     "t64 web Dockerfile referenced" "$WF_TEXT" "file: apps/web/Dockerfile"
expect_not_contains "t65 no Compose build of application images" "$WF_TEXT" "docker compose"
expect_not_contains "t66 no docker-compose build" "$WF_TEXT" "docker-compose"
expect_line_count "t67 both publication jobs push to the registry" 2 '^[[:space:]]*push: true$' "$WF"

# Platform contract: linux/amd64 (the documented VServer target), only.
expect_line_count "t68 both publication jobs build linux/amd64" 2 \
  '^[[:space:]]*platforms: linux/amd64$' "$WF"
expect_line_count "t69 no other platform is built" 2 '^[[:space:]]*platforms:' "$WF"

# Tag contract: the derived image name tagged with the full push SHA;
# no mutable tag anywhere.
expect_line_count "t70 both jobs tag <derived-name>:<full SHA>" 2 \
  '^[[:space:]]*tags: \$\{\{ steps\.image\.outputs\.name \}\}:\$\{\{ env\.FG_PUBLISH_SHA \}\}$' "$WF"
expect_line_count "t71 no extra tag input" 2 '^[[:space:]]*tags:' "$WF"
expect_not_contains "t72 no latest tag anywhere" "$WF_TEXT" ":latest"
expect_not_contains "t73 no branch tag anywhere" "$WF_TEXT" ":main"

# Lowercase image names: no unsupported expression-level lowercasing, no
# hardcoded owner/repository; lowercasing happens in an executable
# runtime Bash step on the runner.
# (The needle is assembled from parts so this test file itself never
# contains the unsupported expression text.)
TOLOWER_NEEDLE="toLo""wer("
expect_not_contains "t74 no unsupported expression-level lowercasing" "$WF_TEXT" "$TOLOWER_NEEDLE"
expect_line_count "t75 no hardcoded lowercase owner/repository in any ghcr.io path" 0 \
  'ghcr\.io/[a-z0-9_-]+/[a-z0-9._-]+' "$WF"
expect_line_count "t76 runtime derive step on both publication jobs" 2 \
  '^[[:space:]]*id: image$' "$WF"
expect_fixed_count "t77 runtime lowercasing in a Bash step (both jobs)" 2 \
  'repository="${GH_REPOSITORY,,}"' "$WF"
expect_line_count "t78 derive step reads github.repository via env (both jobs)" 2 \
  '^[[:space:]]*GH_REPOSITORY: \$\{\{ github\.repository \}\}$' "$WF"
expect_fixed_count "t79 derive step writes GITHUB_OUTPUT (both jobs)" 2 \
  '>> "$GITHUB_OUTPUT"' "$WF"
expect_fixed_count "t80 API image reference ends in -api" 1 \
  'echo "name=ghcr.io/${repository}-api" >> "$GITHUB_OUTPUT"' "$WF"
expect_fixed_count "t81 web image reference ends in -web" 1 \
  'echo "name=ghcr.io/${repository}-web" >> "$GITHUB_OUTPUT"' "$WF"

# The derived step output is the single source for tag, labels, report.
expect_fixed_count "t82 OCI source label on both images" 2 'org.opencontainers.image.source=' "$WF"
expect_fixed_count "t83 OCI revision label on both images" 2 'org.opencontainers.image.revision=' "$WF"
expect_contains "t84 revision label carries the publish SHA" \
  "$WF_TEXT" "org.opencontainers.image.revision=\${{ env.FG_PUBLISH_SHA }}"
expect_fixed_count "t85 OCI repos label uses the derived image name (both jobs)" 2 \
  'org.opencontainers.image.repos=${{ steps.image.outputs.name }}' "$WF"
expect_fixed_count "t86 publication report uses the derived image name (both jobs)" 2 \
  'PUBLISHED_IMAGE: ${{ steps.image.outputs.name }}' "$WF"

# Main-run concurrency: queued, never cancelled (same effective behavior
# as the former standalone core gate); no queue: max in this topology.
expect_line_count "t87 concurrency block present" 1 '^concurrency:$' "$WF"
expect_contains     "t87 concurrency group set" "$WF_TEXT" "group: publish-"
expect_line_count "t88 main runs are queued, never cancelled" 1 \
  '^  cancel-in-progress: false$' "$WF"
expect_not_contains "t89 no queue: max in this topology" "$WF_TEXT" "queue:"

# Compose compatibility: the topology still consumes the images through
# the required variables and hardcodes no image name.
expect_contains "t90 compose still requires FG_WEB_IMAGE" "$COMPOSE_TEXT" 'FG_WEB_IMAGE:?FG_WEB_IMAGE is required'
expect_contains "t91 compose still requires FG_API_IMAGE" "$COMPOSE_TEXT" 'FG_API_IMAGE:?FG_API_IMAGE is required'
expect_not_contains "t92 compose hardcodes no GHCR image name" "$COMPOSE_TEXT" "ghcr.io"

# No branch-protection configuration in the workflow.
expect_not_contains "t93 no branch protection configuration" "$WF_TEXT" "branch_protection"

# Optional: full GitHub-semantic lint when actionlint is installed.
if command -v actionlint >/dev/null 2>&1; then
  AOUT="$(actionlint "$WF" 2>&1)" && ok "t94 actionlint: no issues" \
    || { bad "t94 actionlint: no issues"; printf '%s\n' "$AOUT"; }
else
  printf 'skip t94 actionlint (not installed; GitHub-semantic validation not available here)\n'
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
