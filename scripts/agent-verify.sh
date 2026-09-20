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
# Optional machine-readable run summary (run mode only):
#   ./scripts/agent-verify.sh --summary-json <path> <profile>
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
#     playwright-report/, test-results/) — and, only when --summary-json
#     is given, the one explicit summary file at the given path.
#   * A skipped or refused phase is never reported as passed.

set -Eeuo pipefail

CALLER_CWD="$(pwd)"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERIFY_MODE="run"
PROFILE=""
E2E_ARGS=()
PHASE_COUNT=0
COMPLETED=0
VERIFY_STARTED_AT=$SECONDS

# Optional --summary-json state.
SUMMARY_JSON=""          # absolute target path ("" = summary disabled)
AGENT_RUN_ID=""          # explicit run correlation id from FG_AGENT_RUN_ID
SUMMARY_ARMED=0          # 1 once the target path has been validated
SUMMARY_WRITTEN=0        # 1 once the summary file is in place
SUMMARY_TMP=""           # in-flight temporary file (cleaned on exit/signal)
SUMMARY_START_MS=0
SUMMARY_STARTED_AT=""

# Phase tracking. PLANNED_* holds the profile's full phase list in stable
# order; PHASE_* holds the phases entered so far in this run. Both are
# populated by run_cmd from the same profile functions (one source of
# truth); the PLANNED_* copy is taken by a plan-mode enumeration pass.
PLANNED_NAMES=()
PLANNED_COMMANDS=()
PLANNED_COUNT=0
PHASE_NAMES=()
PHASE_COMMANDS=()
PHASE_DURATIONS=()

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

print_fail_banner() {
  printf '\nagent-verify: profile=%s result=FAIL (phase exit code %d, after %ds) — the failing phase is the last one printed above.\n' \
    "$PROFILE" "$1" "$((SECONDS - VERIFY_STARTED_AT))" >&2
}

on_failure() {
  print_fail_banner "$?"
}
trap on_failure ERR

# Epoch time in milliseconds (portable: $SECONDS is whole seconds only).
now_ms() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    printf '%s000' "${EPOCHREALTIME%.*}"
  else
    printf '%s000' "$(date +%s)"
  fi
}

# Escape a string for inclusion in a JSON double-quoted literal.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  printf '%s' "$s"
}

help_text() {
  cat <<'EOF'
Usage:
  ./scripts/agent-verify.sh --help
  ./scripts/agent-verify.sh plan <profile>
  ./scripts/agent-verify.sh --summary-json <path> <profile> [playwright-args]
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
  --summary-json is rejected for plan (plan must not claim a run).

--summary-json <path> <profile>
  Runs the profile normally and additionally writes exactly one versioned
  JSON run summary to <path>, on pass and on fail-fast. The human-readable
  output and the exit codes are unchanged; without --summary-json no JSON
  file is created.
  * <path> is explicit. Relative paths resolve against the caller's
    working directory. The target directory must already exist and be
    writable; agent-verify never creates directories. An invalid target is
    rejected before any phase runs.
  * The file is written atomically: a temporary file in the target
    directory, then a rename. The temporary file is removed on errors and
    on signals.
  * The summary contains only the profile name, the exact phase names and
    announced commands, timings, and exit codes. It never contains
    environment variables, secrets, or command output.
  * The summary is execution evidence only. It records which phases were
    planned, executed, passed, failed, or not started after a failure. It
    never claims RUNTIME_VERIFIED; that judgment belongs to the Evidence
    contract applied to the specific gate.
  JSON schema (schemaVersion 1):
    {
      "schemaVersion": 1,
      "profile": "<profile>",
      "mode": "run",
      "agentRunId": "<run-id>" | null,   # set from FG_AGENT_RUN_ID when the
                                          # summary belongs to a captured run
      "result": "pass" | "fail",
      "exitCode": <number>,
      "startedAt": "<ISO-8601 UTC>",
      "finishedAt": "<ISO-8601 UTC>",
      "durationMs": <number>,
      "phases": [
        { "name": "...", "command": "...",
          "outcome": "passed" | "failed" | "not_run",
          "exitCode": <number | null>, "durationMs": <number> }
      ]
    }
  On fail-fast the failed phase is "failed" with its real exit code and
  every later profile phase is "not_run" (exitCode null). The top-level
  exitCode always equals the process exit code.

Extra arguments are forwarded to Playwright only for the e2e and full
profiles; all other profiles reject extra arguments.

Environment variables:
  FG_ALLOW_E2E_RESET=1   Required to run the e2e/full profiles (consent to
                         the destructive fg_e2e schema reset).
  FG_AGENT_RUN_ID=<id>   Optional explicit correlation id for the JSON
                         summary (letters/digits/._- , max 128 chars).
                         Record it in the summary as "agentRunId" so the
                         Run Ledger (./scripts/agent-observability ledger)
                         can attribute this verification evidence to a
                         specific captured run. Never guessed by timestamp.
  POSTGRES_HOST / POSTGRES_PORT / POSTGRES_DB / POSTGRES_USER /
  POSTGRES_PASSWORD      Django database configuration overrides
                         (defaults match the local development database).

Exit codes:
  0                    profile passed (--help and plan also exit 0).
  <phase exit code>    fail-fast: the failing phase's own nonzero status.
  2                    usage error, unknown profile, missing E2E consent,
                       or an invalid --summary-json target (including
                       --summary-json with plan).
  75                   verification passed but the JSON summary could not
                       be written.
EOF
}

# Run one Django management command in the canonical uv environment.
django() {
  local django_args=("$@")
  (cd "$REPO_ROOT/apps/api" && exec uv run python manage.py "${django_args[@]}")
}

# run_cmd <phase> <mutation-classification> <display-command> <command...>
# In plan mode the phase is printed without executing; in run mode it is
# executed and its nonzero exit status aborts the script (fail-fast).
# The phase name and the exact announced command are recorded for the
# optional JSON run summary.
run_cmd() {
  local phase="$1"
  local mutation="$2"
  local display="$3"
  shift 3
  PHASE_COUNT=$((PHASE_COUNT + 1))
  PHASE_NAMES+=("$phase")
  PHASE_COMMANDS+=("$display")
  if [ "$VERIFY_MODE" = "plan" ]; then
    printf '  %2d  %-24s mutates: %s\n' "$PHASE_COUNT" "$phase" "$mutation"
    printf '      $ %s\n' "$display"
    return 0
  fi
  printf '\n==> %s\n' "$phase"
  printf '    mutates: %s\n' "$mutation"
  printf '$ %s\n' "$display"
  local phase_start_ms phase_dur_ms rc=0
  phase_start_ms="$(now_ms)"
  "$@" || rc=$?
  phase_dur_ms=$(( $(now_ms) - phase_start_ms ))
  PHASE_DURATIONS+=("$phase_dur_ms")
  if [ "$rc" -ne 0 ]; then
    if [ "$SUMMARY_ARMED" -eq 1 ]; then
      summary_finish "fail" "$rc" "$COMPLETED" || true
    fi
    print_fail_banner "$rc"
    exit "$rc"
  fi
  COMPLETED=$((COMPLETED + 1))
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

# --- Optional machine-readable run summary (--summary-json) --------------

# Validate the explicit target before any phase may run. The target
# directory must already exist and be writable; nothing is created.
summary_validate_target() {
  [ -n "$SUMMARY_JSON" ] || fail "--summary-json requires a file path."
  local dir probe
  dir="$(dirname -- "$SUMMARY_JSON")"
  if [ ! -d "$dir" ]; then
    fail "--summary-json: target directory does not exist: $dir (create it first; agent-verify never creates directories)."
  fi
  if [ -e "$SUMMARY_JSON" ] && [ ! -f "$SUMMARY_JSON" ]; then
    fail "--summary-json: target path exists and is not a regular file: $SUMMARY_JSON"
  fi
  if ! probe="$(mktemp "$dir/.agent-verify-summary-probe.XXXXXX" 2>/dev/null)"; then
    fail "--summary-json: target directory is not writable: $dir"
  fi
  rm -f -- "$probe"
  SUMMARY_ARMED=1
}

# Collect the profile's full phase list (names and announced commands) in
# stable order by running its own phase functions in plan mode, which
# executes nothing. The profile functions remain the single source of
# truth; output is suppressed.
enumerate_profile_phases() {
  local saved_mode="$VERIFY_MODE"
  PHASE_COUNT=0
  PHASE_NAMES=()
  PHASE_COMMANDS=()
  VERIFY_MODE="plan"
  case "$PROFILE" in
    quick)    profile_quick    >/dev/null ;;
    frontend) profile_frontend >/dev/null ;;
    backend)  profile_backend  >/dev/null ;;
    core)     profile_core     >/dev/null ;;
    e2e)      profile_e2e      >/dev/null ;;
    full)     profile_full     >/dev/null ;;
  esac
  VERIFY_MODE="$saved_mode"
  PLANNED_COUNT="$PHASE_COUNT"
  PLANNED_NAMES=("${PHASE_NAMES[@]}")
  PLANNED_COMMANDS=("${PHASE_COMMANDS[@]}")
}

# build_summary_json <result> <exit-code> <failed-index|-1> <started-at>
# <finished-at> <total-ms>
# Prints the versioned JSON document. Field names, data types, key order,
# and phase order are deterministic; only timing values are run-dependent.
build_summary_json() {
  local result="$1" code="$2" failed_idx="$3" started_at="$4" finished_at="$5" total_ms="$6"
  local i outcome pcode pdur
  local phases=""
  for ((i = 0; i < PLANNED_COUNT; i++)); do
    if [ "$result" = "pass" ]; then
      outcome="passed"; pcode=0
    elif [ "$failed_idx" -ge 0 ] && [ "$i" -eq "$failed_idx" ]; then
      outcome="failed"; pcode="$code"
    elif [ "$i" -lt "$COMPLETED" ]; then
      outcome="passed"; pcode=0
    else
      outcome="not_run"; pcode="null"
    fi
    pdur="${PHASE_DURATIONS[$i]:-0}"
    phases+="$(printf '    {\n      "name": "%s",\n      "command": "%s",\n      "outcome": "%s",\n      "exitCode": %s,\n      "durationMs": %s\n    }\n' \
      "$(json_escape "${PLANNED_NAMES[$i]}")" \
      "$(json_escape "${PLANNED_COMMANDS[$i]}")" \
      "$outcome" "$pcode" "$pdur")"
    if [ "$i" -lt $((PLANNED_COUNT - 1)) ]; then
      phases+=$',\n'
    else
      phases+=$'\n'
    fi
  done
  printf '{\n'
  printf '  "schemaVersion": 1,\n'
  printf '  "profile": "%s",\n' "$(json_escape "$PROFILE")"
  printf '  "mode": "run",\n'
  if [ -n "$AGENT_RUN_ID" ]; then
    printf '  "agentRunId": "%s",\n' "$(json_escape "$AGENT_RUN_ID")"
  else
    printf '  "agentRunId": null,\n'
  fi
  printf '  "result": "%s",\n' "$result"
  printf '  "exitCode": %s,\n' "$code"
  printf '  "startedAt": "%s",\n' "$started_at"
  printf '  "finishedAt": "%s",\n' "$finished_at"
  printf '  "durationMs": %s,\n' "$total_ms"
  printf '  "phases": [\n'
  printf '%s' "$phases"
  printf '  ]\n'
  printf '}\n'
}

# summary_finish <result:pass|fail> <exit-code> <failed-index|-1>
# Writes the summary atomically: a temporary file in the target directory,
# then a rename. Returns nonzero (after cleanup) if the write is impossible.
summary_finish() {
  local result="$1" code="$2" failed_idx="$3"
  local finished_at total_ms dir tmp
  local json
  finished_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  total_ms=$(( $(now_ms) - SUMMARY_START_MS ))
  json="$(build_summary_json "$result" "$code" "$failed_idx" "$SUMMARY_STARTED_AT" "$finished_at" "$total_ms")"
  dir="$(dirname -- "$SUMMARY_JSON")"
  if ! tmp="$(mktemp "$dir/.agent-verify-summary.XXXXXX" 2>/dev/null)"; then
    printf 'agent-verify: ERROR: cannot create a temporary file in %s for the JSON summary\n' "$dir" >&2
    return 1
  fi
  SUMMARY_TMP="$tmp"
  if ! printf '%s\n' "$json" >"$tmp"; then
    rm -f -- "$tmp"
    SUMMARY_TMP=""
    printf 'agent-verify: ERROR: cannot write the JSON summary to %s\n' "$SUMMARY_JSON" >&2
    return 1
  fi
  if ! mv -f -- "$tmp" "$SUMMARY_JSON"; then
    rm -f -- "$tmp"
    SUMMARY_TMP=""
    printf 'agent-verify: ERROR: cannot move the JSON summary into place at %s\n' "$SUMMARY_JSON" >&2
    return 1
  fi
  SUMMARY_TMP=""
  SUMMARY_WRITTEN=1
  return 0
}

# Defensive cleanup on any exit: a summary that is armed but was never
# written (unexpected harness failure) is still written best-effort with
# every not-completed phase recorded as not_run; the temporary file is
# always removed.
on_exit() {
  local code=$?
  if [ "$SUMMARY_ARMED" -eq 1 ] && [ "$SUMMARY_WRITTEN" -eq 0 ]; then
    summary_finish "fail" "$code" -1 || true
  fi
  if [ -n "$SUMMARY_TMP" ]; then
    rm -f -- "$SUMMARY_TMP" 2>/dev/null
  fi
  return 0
}
trap on_exit EXIT

on_signal() {
  local sig="$1"
  trap - INT TERM
  if [ -n "$SUMMARY_TMP" ]; then
    rm -f -- "$SUMMARY_TMP" 2>/dev/null
  fi
  trap - "$sig"
  kill -s "$sig" $$
}
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

# --- Dispatch -------------------------------------------------------------

main() {
  local summary_path=""
  if [ "$#" -gt 0 ] && [ "$1" = "--summary-json" ]; then
    if [ "$#" -lt 2 ]; then
      fail "--summary-json requires a file path argument (see --help)."
    fi
    summary_path="$2"
    shift 2
    if [ "$#" -gt 0 ] && [ "$1" = "--summary-json" ]; then
      fail "--summary-json may only be given once."
    fi
  fi

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
      if [ -n "$summary_path" ]; then
        fail "--summary-json is not supported for plan: plan is read-only and must not claim a run."
      fi
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

  # Resolve and validate the summary target before any phase may run.
  if [ -n "$summary_path" ]; then
    case "$summary_path" in
      /*) SUMMARY_JSON="$summary_path" ;;
      *)  SUMMARY_JSON="$CALLER_CWD/$summary_path" ;;
    esac
    # Validate the explicit run correlation id before arming the summary
    # target: a rejected id must not leave a summary behind.
    if [ -n "${FG_AGENT_RUN_ID:-}" ]; then
      case "${FG_AGENT_RUN_ID}" in
        *[!A-Za-z0-9._-]*)
          fail "FG_AGENT_RUN_ID contains invalid characters (allowed: letters, digits, '.', '_', '-')." ;;
      esac
      if [ "${#FG_AGENT_RUN_ID}" -gt 128 ]; then
        fail "FG_AGENT_RUN_ID exceeds the 128 character bound."
      fi
      AGENT_RUN_ID="$FG_AGENT_RUN_ID"
    fi
    summary_validate_target
    SUMMARY_START_MS="$(now_ms)"
    SUMMARY_STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    enumerate_profile_phases
  fi

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

  PHASE_COUNT=0
  COMPLETED=0
  PHASE_NAMES=()
  PHASE_COMMANDS=()
  PHASE_DURATIONS=()

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

  if [ "$SUMMARY_ARMED" -eq 1 ]; then
    if ! summary_finish "pass" 0 -1; then
      printf 'agent-verify: ERROR: the profile passed, but the JSON summary could not be written to %s\n' "$SUMMARY_JSON" >&2
      exit 75
    fi
  fi
}

main "$@"
