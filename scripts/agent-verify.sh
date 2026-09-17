#!/usr/bin/env bash
#
# Repository verification interface for agent tasks (and, later, CI).
#
# Profiles (phases execute deterministically, sequentially, no retries):
#
#   quick     Fast static validation. Sandbox-safe: no unit tests, no
#             builds, no backend test suite, no browser.
#             repo hygiene, frontend typecheck, frontend lint,
#             Django system check, Django migration-drift check.
#
#   frontend  Complete non-browser frontend validation:
#             typecheck, lint, complete unit suite, design-token contract
#             suite, production build.
#
#   backend   Complete backend validation in the canonical uv environment:
#             Django system check, migration-drift check, complete Django
#             test suite.
#
#   core      All complete non-browser validation:
#             repo hygiene + frontend + backend.
#             Strongest profile expected to pass inside the agent sandbox.
#
#   e2e       Browser E2E only (Playwright). Requires a browser-capable
#             environment and FG_ALLOW_E2E_RESET=1, because the configured
#             Playwright startup resets the fg_e2e schema. Refuses (before
#             starting servers or touching the database) without opt-in.
#
#   full      core + e2e. Never silently skips E2E: it fails clearly when
#             the browser environment or the destructive-reset opt-in is
#             absent. A passing `full` means every frontend, backend, and
#             browser-E2E surface actually ran successfully.
#
# Non-mutating inspection:
#   ./scripts/agent-verify.sh plan <profile>
#
# Help:
#   ./scripts/agent-verify.sh --help
#
# Guarantees:
#   * Operates from the repository root regardless of caller CWD.
#   * Strict error handling; a failing phase aborts the script with that
#     phase's own nonzero exit status.
#   * No dependency installation, no parallelism, no retries.
#   * No Git state mutation; only artifacts the canonical commands
#     themselves produce (dist/, tsc build info, Django test database,
#     playwright-report/, test-results/).
#   * A skipped or refused phase is never reported as passed.

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERIFY_MODE="run"
PROFILE=""
E2E_ARGS=()
PHASE_COUNT=0
VERIFY_STARTED_AT=$SECONDS

# Mutation classifications printed for every phase (plan and run).
MUTATE_NONE="none"
MUTATE_BUILD="build output only (apps/web/dist, gitignored)"
MUTATE_TESTDB="Django test database only (created and dropped; development database untouched)"
MUTATE_E2E="DESTRUCTIVE: resets fg_e2e schema (DROP SCHEMA CASCADE + migrate + seed); writes playwright-report/ and test-results/"

fail() {
  printf 'agent-verify: ERROR: %s\n' "$1" >&2
  printf 'Run "%s --help" for valid usage.\n' "$0" >&2
  exit 2
}

on_failure() {
  local code=$?
  printf '\nagent-verify: profile=%s result=FAIL (phase exit code %d, after %ds) — the failing phase is the last one printed above.\n' \
    "$PROFILE" "$code" "$((SECONDS - VERIFY_STARTED_AT))" >&2
}
trap on_failure ERR

help_text() {
  cat <<'EOF'
Usage:
  ./scripts/agent-verify.sh --help
  ./scripts/agent-verify.sh plan <profile>
  ./scripts/agent-verify.sh <profile> [playwright-args]

Profiles:
  quick     Fast static validation (sandbox-safe): repo hygiene, frontend
            typecheck, frontend lint, Django system check, Django
            migration-drift check. No unit tests, no builds, no backend
            test suite, no E2E.
  frontend  Complete non-browser frontend validation: typecheck, lint,
            complete unit suite, design-token contract suite, production
            build.
  backend   Complete backend validation: Django system check,
            migration-drift check, complete Django test suite (canonical
            uv environment under apps/api).
  core      All complete non-browser validation: repo hygiene + frontend
            + backend. Strongest profile expected to pass in the agent
            sandbox.
  e2e       Browser E2E only (Playwright). Requires a browser-capable
            environment and FG_ALLOW_E2E_RESET=1: the configured Playwright
            startup resets the fg_e2e schema (DROP SCHEMA CASCADE +
            migrate + seed). Refuses before any server starts or database
            state changes when the opt-in is absent.
  full      core + e2e. Fails clearly when the E2E opt-in or browser
            environment is absent; never silently skips E2E.

plan <profile>
  Prints the execution order, exact commands, environment requirements,
  and mutation flags of a profile. Executes nothing and mutates nothing.

Extra arguments are forwarded to Playwright only for the e2e and full
profiles; all other profiles reject extra arguments.

Environment variables:
  FG_ALLOW_E2E_RESET=1   Required to run the e2e/full profiles (consent to
                         the destructive fg_e2e schema reset).
  POSTGRES_HOST / POSTGRES_PORT / POSTGRES_DB / POSTGRES_USER /
  POSTGRES_PASSWORD      Django database configuration overrides
                         (defaults match the local development database).
EOF
}

# Run one Django management command in the canonical uv environment.
django() {
  local django_args=("$@")
  (cd "$REPO_ROOT/apps/api" && exec uv run python manage.py "${django_args[@]}")
}

# run_cmd <phase> <mutation-classification> <display-command> <command...>
# In plan mode the phase is printed without executing; in run mode it is
# executed and its nonzero exit status aborts the script (set -Eeuo).
run_cmd() {
  local phase="$1"
  local mutation="$2"
  local display="$3"
  shift 3
  PHASE_COUNT=$((PHASE_COUNT + 1))
  if [ "$VERIFY_MODE" = "plan" ]; then
    printf '  %2d  %-24s mutates: %s\n' "$PHASE_COUNT" "$phase" "$mutation"
    printf '      $ %s\n' "$display"
    return 0
  fi
  printf '\n==> %s\n' "$phase"
  printf '    mutates: %s\n' "$mutation"
  printf '$ %s\n' "$display"
  "$@"
}

# --- Phases ---------------------------------------------------------------

phase_repo_hygiene() {
  run_cmd "repo: hygiene" "$MUTATE_NONE" "git diff HEAD --check" git diff HEAD --check
}

phase_frontend_typecheck() {
  run_cmd "frontend: typecheck" "$MUTATE_NONE" "npm run typecheck" npm run typecheck
}

phase_frontend_lint() {
  run_cmd "frontend: lint" "$MUTATE_NONE" "npm run lint" npm run lint
}

phase_frontend_unit() {
  run_cmd "frontend: unit tests" "$MUTATE_NONE" "npm run test:unit --workspace=web" npm run test:unit --workspace=web
}

phase_frontend_tokens() {
  run_cmd "frontend: token contract" "$MUTATE_NONE" "npm run test:tokens --workspace=web" npm run test:tokens --workspace=web
}

phase_frontend_build() {
  run_cmd "frontend: build" "$MUTATE_BUILD" "npm run build" npm run build
}

phase_django_check() {
  run_cmd "backend: django check" "$MUTATE_NONE" "cd apps/api && uv run python manage.py check" django check
}

phase_django_migrations() {
  run_cmd "backend: migration drift" "$MUTATE_NONE" "cd apps/api && uv run python manage.py makemigrations --check --dry-run" django makemigrations --check --dry-run
}

phase_django_tests() {
  run_cmd "backend: django tests" "$MUTATE_TESTDB" "cd apps/api && uv run python manage.py test" django test
}

phase_e2e() {
  local display="npm run test:e2e"
  local cmd_args=(npm run test:e2e)
  local a
  if [ "${#E2E_ARGS[@]}" -gt 0 ]; then
    cmd_args+=(-- "${E2E_ARGS[@]}")
    for a in "${E2E_ARGS[@]}"; do
      display="$display -- $a"
    done
  fi
  run_cmd "e2e: playwright" "$MUTATE_E2E" "$display" "${cmd_args[@]}"
}

# --- Profiles -------------------------------------------------------------

profile_quick() {
  phase_repo_hygiene
  phase_frontend_typecheck
  phase_frontend_lint
  phase_django_check
  phase_django_migrations
}

profile_frontend() {
  phase_frontend_typecheck
  phase_frontend_lint
  phase_frontend_unit
  phase_frontend_tokens
  phase_frontend_build
}

profile_backend() {
  phase_django_check
  phase_django_migrations
  phase_django_tests
}

profile_core() {
  phase_repo_hygiene
  profile_frontend
  profile_backend
}

profile_e2e() {
  phase_e2e
}

profile_full() {
  profile_core
  profile_e2e
}

# --- Environment requirements (printed by plan, enforced at run time) -----

req_node() {
  printf '  - Node.js >= 24 with npm workspaces installed (npm ci); this script never installs dependencies\n'
}

req_uv() {
  printf '  - uv installed and the uv environment under apps/api in sync (uv sync); this script never installs dependencies\n'
}

req_pg() {
  printf '  - PostgreSQL reachable for Django (default localhost:5432; overridable via POSTGRES_HOST/PORT/DB/USER/PASSWORD); the backend test suite creates and drops its own test database\n'
}

req_browser() {
  printf '  - browser-capable environment (Chromium must be launchable; unavailable in the agent sandbox)\n'
}

req_consent() {
  printf '  - FG_ALLOW_E2E_RESET=1 (Playwright startup resets the fg_e2e schema: DROP SCHEMA CASCADE + migrate + seed)\n'
}

print_requirements() {
  case "$1" in
    quick)
      req_node
      req_uv
      printf '  - no database connection required (system check and makemigrations --check do not connect)\n'
      ;;
    frontend)
      req_node
      printf '  - no database required\n'
      ;;
    backend)
      req_uv
      req_pg
      ;;
    core)
      req_node
      req_uv
      req_pg
      ;;
    e2e|full)
      req_node
      req_uv
      req_pg
      req_browser
      req_consent
      ;;
  esac
}

# Refuse E2E before any server starts or database state changes.
e2e_refuse() {
  {
    printf 'agent-verify: REFUSING the e2e phase before starting any server or touching the database.\n'
    printf '\n'
    printf 'Reasons:\n'
    printf '  * Browser E2E requires a browser-capable environment (Chromium must be\n'
    printf '    launchable). In the agent sandbox Chromium cannot launch.\n'
    printf '  * The configured Playwright webServer startup runs\n'
    printf '    `uv run python manage.py reset_e2e` (DJANGO_SETTINGS_MODULE=config.settings_e2e),\n'
    printf '    which executes DROP SCHEMA fg_e2e CASCADE, re-applies migrations,\n'
    printf '    and re-seeds the fg_e2e schema. This is a destructive database reset.\n'
    printf '\n'
    printf 'To run E2E, on a browser-capable machine with explicit consent to the reset:\n'
    printf '  FG_ALLOW_E2E_RESET=1 %s e2e [playwright args]\n' "$0"
  } >&2
  exit 2
}

require_e2e_consent() {
  [ "$VERIFY_MODE" = "run" ] || return 0
  if [ "${FG_ALLOW_E2E_RESET:-0}" != "1" ]; then
    e2e_refuse
  fi
  printf 'agent-verify: e2e requires a browser-capable environment; FG_ALLOW_E2E_RESET=1 acknowledged.\n'
  printf 'agent-verify: the Playwright startup will reset the fg_e2e schema (destructive).\n'
}

# --- Dispatch -------------------------------------------------------------

main() {
  if [ "$#" -eq 0 ]; then
    fail "missing profile. Valid profiles: quick, frontend, backend, core, e2e, full (plus 'plan <profile>' and '--help')."
  fi
  local first="$1"
  case "$first" in
    --help|-h|help)
      help_text
      exit 0
      ;;
    plan)
      if [ "$#" -ne 2 ]; then
        fail "plan takes exactly one argument: ./scripts/agent-verify.sh plan <profile>"
      fi
      VERIFY_MODE="plan"
      PROFILE="$2"
      ;;
    quick|frontend|backend|core)
      if [ "$#" -ne 1 ]; then
        fail "profile '$first' takes no extra arguments (Playwright arguments are accepted only by e2e and full)."
      fi
      PROFILE="$first"
      ;;
    e2e|full)
      PROFILE="$first"
      shift
      E2E_ARGS=("$@")
      ;;
    *)
      fail "unknown profile '$first'. Valid profiles: quick, frontend, backend, core, e2e, full (plus 'plan <profile>' and '--help')."
      ;;
  esac

  case "$PROFILE" in
    e2e|full) require_e2e_consent ;;
  esac

  if [ "$VERIFY_MODE" = "plan" ]; then
    printf 'agent-verify plan: profile=%s (inspection only: nothing executes, no state is mutated)\n\n' "$PROFILE"
    printf 'Environment requirements:\n'
    print_requirements "$PROFILE"
    printf '\nExecution order:\n'
  else
    printf 'agent-verify: profile=%s mode=run (sequential; any failing phase aborts with its exit code)\n' "$PROFILE"
  fi

  case "$PROFILE" in
    quick)    profile_quick ;;
    frontend) profile_frontend ;;
    backend)  profile_backend ;;
    core)     profile_core ;;
    e2e)      profile_e2e ;;
    full)     profile_full ;;
  esac

  printf '\nagent-verify: profile=%s result=PASS (%d phase%s, %ds)\n' \
    "$PROFILE" "$PHASE_COUNT" "$([ "$PHASE_COUNT" -eq 1 ] || printf s)" "$((SECONDS - VERIFY_STARTED_AT))"
}

main "$@"
