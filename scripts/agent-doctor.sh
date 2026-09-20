#!/usr/bin/env bash
#
# Read-only environment doctor for FG Workspace verification capabilities.
#
# One command answers: which verification capabilities are available or
# blocked in the CURRENT environment?
#
#   ./scripts/agent-doctor.sh          human-readable capability matrix
#   ./scripts/agent-doctor.sh --json   stable machine-readable JSON
#   ./scripts/agent-doctor.sh --help   usage, status values, exit codes
#
# Diagnostics performed (fixed order):
#   repo_workspace      git worktree + workspace writability
#   node_runtime        Node.js >= 24 (engines contract)
#   npm                 npm package manager
#   uv_runtime          uv (canonical backend environment tool)
#   python_runtime      Python >= 3.12 (prefer apps/api/.venv)
#   frontend_deps       node_modules with the packages the frontend gates need
#   backend_deps        apps/api/.venv with django / djangorestframework / psycopg
#   database            PostgreSQL reachability; the only statement executed
#                       is a read-only SELECT 1
#   frontend_gate       prerequisites of the `frontend` verify profile
#   backend_gate        prerequisites of the `backend` verify profile
#   quick_gate          prerequisites of the `quick` verify profile (no DB)
#   playwright_runtime  @playwright/test + installed Chromium executable
#   chromium_launch     bounded headless launch preflight (about:blank, then
#                       the browser is closed; no product page, no data)
#   e2e_gate            prerequisites of the `e2e` verify profile; the doctor
#                       never sets FG_ALLOW_E2E_RESET and never touches the
#                       fg_e2e schema
#   network             deterministic TCP probe + proxy-env observation
#   agent_observability OPTIONAL local trace-capture collector (otelcol).
#                       Never gates the doctor result unless
#                       FG_DOCTOR_REQUIRE_OBSERVABILITY=1 is set.
#
# Read-only contract (hard guarantees):
#   * no tests are executed, no services or browsers are left running,
#     no dependencies are installed
#   * no working-tree, git, or database mutation (database access is
#     connect + SELECT 1 only)
#   * output never contains secrets or full environment dumps
#
# Status values:
#   available    capability is present and works in this environment
#   unavailable  a required component or dependency is missing
#   blocked      component present, but unusable in this environment
#                (sandbox/policy, failing browser launch, auth failure, ...)
#   unknown      not determinable without mutation or extra context
#
# Exit codes:
#   0  all capabilities available
#   1  diagnosis completed; >=1 capability is blocked/unavailable/unknown
#   2  usage error
#   3  internal doctor failure

set -Eeuo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
case "$SCRIPT_PATH" in
  */*) REPO_ROOT="$(cd "${SCRIPT_PATH%/*}/.." && pwd)" ;;
  *)   REPO_ROOT="$(cd .. && pwd)" ;;
esac
cd "$REPO_ROOT"

DOCTOR_TOOL="agent-doctor"
SCHEMA_VERSION=1
PREFLIGHT_TIMEOUT_MS=10000
VENV_PY="$REPO_ROOT/apps/api/.venv/bin/python"
DETAIL_MAX=240

CAP_NAMES=()
CAP_STATUSES=()
CAP_DETAILS=()

# ---------------------------------------------------------------- helpers ---

add_cap() {
  local detail="$3"
  detail="${detail:0:$DETAIL_MAX}"
  CAP_NAMES+=("$1")
  CAP_STATUSES+=("$2")
  CAP_DETAILS+=("$detail")
}

cap_status_of() {
  local i
  for i in "${!CAP_NAMES[@]}"; do
    if [ "${CAP_NAMES[$i]}" = "$1" ]; then
      printf '%s' "${CAP_STATUSES[$i]}"
      return 0
    fi
  done
  printf 'unknown'
}

cap_detail_of() {
  local i
  for i in "${!CAP_NAMES[@]}"; do
    if [ "${CAP_NAMES[$i]}" = "$1" ]; then
      printf '%s' "${CAP_DETAILS[$i]}"
      return 0
    fi
  done
  printf 'unknown'
}

# Derive a gate status from prerequisite capability names (space-separated).
# Precedence: unavailable > blocked > unknown > available.
derive_gate() {
  local names="$1" n st rank worst=0 worstst="available"
  for n in $names; do
    st="$(cap_status_of "$n")"
    case "$st" in
      available)   rank=0 ;;
      unknown)     rank=1 ;;
      blocked)     rank=2 ;;
      unavailable) rank=3 ;;
      *)           st="unknown"; rank=1 ;;
    esac
    if [ "$rank" -gt "$worst" ]; then
      worst="$rank"
      worstst="$st"
    fi
  done
  printf '%s' "$worstst"
}

# Names of the prerequisites (from a space-separated list) that are not
# available; output "name(status)" pairs separated by "; ".
gate_missing_list() {
  local names="$1" n st out=""
  for n in $names; do
    st="$(cap_status_of "$n")"
    if [ "$st" != "available" ]; then
      if [ -n "$out" ]; then out="$out; "; fi
      out="${out}${n}(${st})"
    fi
  done
  printf '%s' "$out"
}

# Optional capabilities: their status is reported but excluded from the
# overall result / exit code, unless explicitly required.
OPTIONAL_CAPS="agent_observability"
if [ "${FG_DOCTOR_REQUIRE_OBSERVABILITY:-0}" = "1" ]; then
  OPTIONAL_CAPS=""
fi

is_optional_cap() {
  case " $OPTIONAL_CAPS " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

TOL_OUT=""
TOL_RC=0
# Run a command that is allowed to fail. Captures combined output in TOL_OUT
# and the exit status in TOL_RC without tripping set -e or the ERR trap.
run_tolerated() {
  TOL_OUT=""
  TOL_RC=0
  set +Ee
  TOL_OUT="$("$@" 2>&1)" || TOL_RC=$?
  set -Ee
}

count_status() {
  local c=0 i st
  for i in "${!CAP_STATUSES[@]}"; do
    st="${CAP_STATUSES[$i]}"
    if [ "$st" = "$1" ]; then c=$((c + 1)); fi
  done
  printf '%s' "$c"
}

count_status_required() {
  local c=0 i st
  for i in "${!CAP_STATUSES[@]}"; do
    st="${CAP_STATUSES[$i]}"
    if is_optional_cap "${CAP_NAMES[$i]}"; then continue; fi
    if [ "$st" = "$1" ]; then c=$((c + 1)); fi
  done
  printf '%s' "$c"
}

json_escape() {
  local s="$1"
  s="$(printf '%s' "$s" | LC_ALL=C tr -d '\000-\037\177')"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

# stdin: full preflight stderr; stdout: compact, sanitized cause (<=200 chars)
sanitize_launch_error() {
  local esc line first="" cause=""
  esc="$(printf '\033')"
  while IFS= read -r line; do
    line="$(printf '%s' "$line" | sed -E "s/${esc}\[[0-9;]*[A-Za-z]//g")"
    case "$line" in
      doctor-launch-*|'') continue ;;
    esac
    if [ -z "$first" ]; then first="$line"; fi
    case "$line" in
      *"[err]"*)
        if [ -z "$cause" ]; then
          cause="${line##*"[err] "}"
          cause="$(printf '%s' "$cause" | sed -E 's/^\[[^]]*\] *//')"
        fi
        ;;
    esac
  done
  if [ -z "$cause" ]; then cause="$first"; fi
  cause="$(printf '%s' "$cause" \
    | sed -E 's#/var/folders/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#/var/folders/<tmp>#g' \
    | sed -E 's#--user-data-dir=[^ ]*##g' \
    | sed -E 's#pid=[0-9]+#pid=<pid>#g')"
  cause="$(printf '%s' "$cause" | LC_ALL=C tr -d '\000-\037\177')"
  printf '%s' "${cause:0:200}"
}

# Preflight exit code -> capability status (sourceable for tests).
launch_status_for_rc() {
  case "$1" in
    0)   printf 'available' ;;
    *)   printf 'blocked' ;;
  esac
}

# -------------------------------------------------------- capability probes ---

cap_repo_workspace() {
  local branch="" head="" writable="no"
  if git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    head="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
  else
    add_cap "repo_workspace" "unavailable" "not a git worktree at ${REPO_ROOT}"
    REPO_BRANCH=""; REPO_HEAD=""; REPO_WRITABLE="false"
    return 0
  fi
  if [ -w "$REPO_ROOT" ]; then writable="yes"; REPO_WRITABLE="true"; else REPO_WRITABLE="false"; fi
  REPO_BRANCH="$branch"
  REPO_HEAD="$head"
  if [ "$writable" != "yes" ]; then
    add_cap "repo_workspace" "blocked" "git worktree found but the workspace root is not writable"
  else
    add_cap "repo_workspace" "available" "git worktree, branch ${branch:-?} @ ${head:-?}, writable"
  fi
}

cap_node_runtime() {
  if ! command -v node >/dev/null 2>&1; then
    add_cap "node_runtime" "unavailable" "node not found on PATH (required >= 24)"
    return 0
  fi
  local ver major
  run_tolerated node --version
  ver="$TOL_OUT"
  major="${ver#v}"; major="${major%%.*}"
  case "$major" in
    ''|*[!0-9]*) add_cap "node_runtime" "unknown" "node found but version is not parseable: ${ver:-<none>}"; return 0 ;;
  esac
  if [ "$major" -ge 24 ]; then
    add_cap "node_runtime" "available" "node ${ver} (required >= 24)"
  else
    add_cap "node_runtime" "unavailable" "node ${ver} found, but required >= 24"
  fi
}

cap_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    add_cap "npm" "unavailable" "npm not found on PATH"
    return 0
  fi
  local ver
  run_tolerated npm --version
  ver="$TOL_OUT"
  if [ -n "$ver" ]; then
    add_cap "npm" "available" "npm ${ver}"
  else
    add_cap "npm" "unknown" "npm found, but version could not be determined (node runtime problem?)"
  fi
}

cap_uv_runtime() {
  if ! command -v uv >/dev/null 2>&1; then
    add_cap "uv_runtime" "unavailable" "uv not found on PATH (required for the canonical backend environment)"
    return 0
  fi
  local ver
  run_tolerated uv --version
  ver="$TOL_OUT"
  if [ -n "$ver" ]; then
    add_cap "uv_runtime" "available" "$ver"
  else
    add_cap "uv_runtime" "unknown" "uv found, but version could not be determined"
  fi
}

cap_python_runtime() {
  local ver
  if [ -x "$VENV_PY" ]; then
    run_tolerated "$VENV_PY" --version
    ver="$TOL_OUT"
    ver="${ver#Python }"
  elif command -v python3 >/dev/null 2>&1; then
    run_tolerated python3 --version
    ver="$TOL_OUT"
    ver="${ver#Python }"
    ver="${ver} (system python3; apps/api/.venv not set up)"
  else
    add_cap "python_runtime" "unavailable" "no python interpreter found (required >= 3.12)"
    return 0
  fi
  case "$ver" in
    3.12*|3.1[3-9]*|3.[2-9][0-9]*|[4-9].*)
      add_cap "python_runtime" "available" "python ${ver} (required >= 3.12)" ;;
    *)
      add_cap "python_runtime" "unavailable" "python ${ver} found, but required >= 3.12" ;;
  esac
}

cap_frontend_deps() {
  local pkg missing=""
  if [ ! -d "$REPO_ROOT/node_modules" ]; then
    add_cap "frontend_deps" "unavailable" "node_modules missing — run npm ci (doctor does not install)"
    return 0
  fi
  for pkg in react react-dom react-router vite typescript vitest @playwright/test; do
    if [ ! -d "$REPO_ROOT/node_modules/$pkg" ] && [ ! -d "$REPO_ROOT/apps/web/node_modules/$pkg" ]; then
      if [ -n "$missing" ]; then missing="$missing, "; fi
      missing="$missing$pkg"
    fi
  done
  if [ -n "$missing" ]; then
    add_cap "frontend_deps" "unavailable" "node_modules present but missing: ${missing} — run npm ci (doctor does not install)"
  else
    add_cap "frontend_deps" "available" "node_modules present with react, vite, typescript, vitest, @playwright/test"
  fi
}

cap_backend_deps() {
  local out
  if [ ! -x "$VENV_PY" ]; then
    add_cap "backend_deps" "unavailable" "apps/api/.venv missing — run uv sync from apps/api (doctor does not install)"
    return 0
  fi
  run_tolerated "$VENV_PY" -c 'import django, rest_framework, psycopg; print(django.get_version())'
  out="$TOL_OUT"
  if [ "$TOL_RC" -eq 0 ] && [ -n "$out" ]; then
    add_cap "backend_deps" "available" "apps/api/.venv: django ${out}, djangorestframework, psycopg importable"
  else
    add_cap "backend_deps" "unavailable" "apps/api/.venv present but django/djangorestframework/psycopg not importable — run uv sync (doctor does not install)"
  fi
}

DB_PROBE_PY='
import os, socket, sys
host = os.getenv("POSTGRES_HOST", "localhost")
port = int(os.getenv("POSTGRES_PORT", "5432"))
db = os.getenv("POSTGRES_DB", "fg_workspace")
user = os.getenv("POSTGRES_USER", "fg_workspace")
pw = os.getenv("POSTGRES_PASSWORD", "fg_workspace")
out = ["host=%s port=%s" % (host, port)]
try:
    s = socket.create_connection((host, port), timeout=3)
    s.close()
except Exception as e:
    out.append("tcp=fail:" + type(e).__name__)
    print("\n".join(out))
    sys.exit(0)
try:
    import psycopg
except Exception:
    out.append("tcp=ok client=no")
    print("\n".join(out))
    sys.exit(0)
try:
    conn = psycopg.connect(host=host, port=port, dbname=db, user=user,
                           password=pw, connect_timeout=5)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
    finally:
        conn.close()
    out.append("tcp=ok db=ok")
except Exception as e:
    msg = " ".join(str(e).split())
    if pw:
        msg = msg.replace(pw, "[redacted]")
    out.append("tcp=ok db=fail:" + msg[:160])
print("\n".join(out))
'

NET_PROBE_PY='
import socket
try:
    s = socket.create_connection(("registry.npmjs.org", 443), timeout=3)
    s.close()
    print("net=ok")
except Exception as e:
    print("net=fail:" + type(e).__name__)
'

probe_interpreter() {
  # Echoes the python interpreter to use for read-only probes, if any.
  if [ -x "$VENV_PY" ]; then
    printf '%s' "$VENV_PY"
  elif command -v python3 >/dev/null 2>&1; then
    printf '%s' "python3"
  fi
}

proxy_note() {
  if [ -n "${http_proxy:-}${https_proxy:-}${HTTP_PROXY:-}${HTTPS_PROXY:-}" ]; then
    printf ' (HTTP(S) proxy env vars set; values not shown)'
  fi
}

cap_database() {
  local interp out
  interp="$(probe_interpreter)" || interp=""
  if [ -z "$interp" ]; then
    add_cap "database" "unknown" "no python interpreter available for the read-only probe"
    return 0
  fi
  run_tolerated "$interp" -c "$DB_PROBE_PY"
  out="$TOL_OUT"
  local host="${POSTGRES_HOST:-localhost}" port="${POSTGRES_PORT:-5432}" db="${POSTGRES_DB:-fg_workspace}" line
  # The probe prints the host/port line first, then exactly one status line.
  nl=$'\n'
  line="${out##*$nl}"
  case "$line" in
    "tcp=fail:"*)
      add_cap "database" "unavailable" "PostgreSQL not reachable at ${host}:${port} — is the server running?"
      return 0
      ;;
    "tcp=ok client=no")
      add_cap "database" "unknown" "TCP reachable at ${host}:${port}; credentials not verified (no psycopg in probe interpreter)"
      return 0
      ;;
    "tcp=ok db=ok")
      add_cap "database" "available" "connected at ${host}:${port} (database ${db}); read-only SELECT 1 succeeded" ;;
    "tcp=ok db=fail:"*)
      add_cap "database" "blocked" "TCP reachable at ${host}:${port} but connection failed: ${line#tcp=ok db=fail:}" ;;
    *)
      add_cap "database" "unknown" "probe produced no result (postgres ${host}:${port})" ;;
  esac
}

cap_network() {
  local interp out
  interp="$(probe_interpreter)" || interp=""
  if [ -z "$interp" ]; then
    add_cap "network" "unknown" "no python interpreter available for the network probe"
    return 0
  fi
  run_tolerated "$interp" -c "$NET_PROBE_PY"
  out="$TOL_OUT"
  case "$out" in
    "net=ok")
      add_cap "network" "available" "external network reachable (TCP probe registry.npmjs.org:443)$(proxy_note)" ;;
    "net=fail:"*)
      add_cap "network" "blocked" "external network unreachable (TCP probe registry.npmjs.org:443: ${out#net=fail:}) — installation and downloads would fail$(proxy_note)" ;;
    *)
      add_cap "network" "unknown" "network probe produced no result" ;;
  esac
}

PREFLIGHT_NODE_JS='
const { chromium } = require("@playwright/test");
const TIMEOUT_MS = Number(process.env.FG_DOCTOR_PREFLIGHT_TIMEOUT_MS || 10000);
let browser = null;
const finish = (code) => process.exit(code);
const timer = setTimeout(async () => {
  try { if (browser) await browser.close(); } catch (e) {}
  console.error("doctor-launch-timeout");
  finish(124);
}, TIMEOUT_MS);
const hardTimer = setTimeout(() => finish(124), TIMEOUT_MS + 5000);
(async () => {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("about:blank");
  await page.close();
  await browser.close();
  clearTimeout(timer);
  clearTimeout(hardTimer);
  console.error("doctor-launch-ok");
  finish(0);
})().catch((e) => {
  clearTimeout(timer);
  clearTimeout(hardTimer);
  console.error("doctor-launch-fail");
  console.error(String((e && e.message) || e));
  finish(1);
});
'

cap_playwright_runtime() {
  local exe
  if ! command -v node >/dev/null 2>&1; then
    add_cap "playwright_runtime" "unknown" "cannot inspect (node runtime missing)"
    return 0
  fi
  if [ ! -d "$REPO_ROOT/node_modules/@playwright/test" ]; then
    add_cap "playwright_runtime" "unavailable" "@playwright/test missing from node_modules — run npm ci (doctor does not install)"
    return 0
  fi
  # Existence is checked via node on purpose: sandboxed shells may be
  # denied stat() on the Playwright cache while node processes are not.
  run_tolerated node -e 'const p=require("playwright-core").chromium.executablePath(); console.log(p); process.exit(require("fs").existsSync(p)?0:1)'
  exe="$TOL_OUT"
  if [ "$TOL_RC" -eq 0 ]; then
    add_cap "playwright_runtime" "available" "Chromium installed: ${exe}"
  else
    add_cap "playwright_runtime" "unavailable" "Chromium executable not found (${exe:-unknown path}) — run npx playwright install chromium (doctor does not install)"
  fi
}

cap_chromium_launch() {
  local pw_status
  pw_status="$(cap_status_of playwright_runtime)"
  if [ "$pw_status" != "available" ]; then
    add_cap "chromium_launch" "unavailable" "skipped: playwright_runtime is ${pw_status} in this environment"
    return 0
  fi
  run_tolerated env "FG_DOCTOR_PREFLIGHT_TIMEOUT_MS=$PREFLIGHT_TIMEOUT_MS" node -e "$PREFLIGHT_NODE_JS"
  local rc="$TOL_RC" out="$TOL_OUT"
  if [ "$rc" -eq 0 ]; then
    add_cap "chromium_launch" "available" "headless Chromium launch preflight succeeded (page opened, browser closed)"
  elif [ "$rc" -eq 124 ]; then
    add_cap "chromium_launch" "blocked" "launch timed out after $((PREFLIGHT_TIMEOUT_MS / 1000))s (browser force-stopped, nothing left running)"
  else
    local cause
    cause="$(printf '%s\n' "$out" | sanitize_launch_error)"
    add_cap "chromium_launch" "blocked" "launch failed: ${cause:-browser process exited during startup}"
  fi
}

cap_agent_observability() {
  # Optional: local agent trace-capture collector (see
  # ./scripts/agent-observability and docs/agent/OBSERVABILITY.md).
  # Read-only probe: binary discovery + `--version` only.
  local bin ver
  if [ -n "${FG_OTELCOL:-}" ] && [ -x "${FG_OTELCOL:-}" ]; then
    bin="$FG_OTELCOL"
  else
    bin="$(command -v otelcol 2>/dev/null || true)"
    if [ -z "$bin" ]; then
      # Pure-bash discovery (the doctor must stay functional under a
      # restricted PATH: no external commands in this probe).
      local cand
      for cand in "$REPO_ROOT/.artifacts/agent-observability/otelcol"/*/otelcol; do
        if [ -x "$cand" ]; then bin="$cand"; break; fi
      done
    fi
  fi
  if [ -z "$bin" ]; then
    add_cap "agent_observability" "unavailable" "otelcol not found (optional capability) — install: ./scripts/agent-observability install; e2e check: ./scripts/agent-observability doctor"
    return 0
  fi
  run_tolerated "$bin" --version
  if [ "$TOL_RC" -eq 0 ] && [ -n "$TOL_OUT" ]; then
    ver="${TOL_OUT%%$'\n'}"  # first line, pure bash (restricted-PATH safe)
    add_cap "agent_observability" "available" "${ver} (optional; not part of the doctor result unless FG_DOCTOR_REQUIRE_OBSERVABILITY=1)"
  else
    add_cap "agent_observability" "blocked" "otelcol found (${bin}) but --version failed: ${TOL_OUT:0:120}"
  fi
}

# ------------------------------------------------------------- gate probes ---

cap_frontend_gate() {
  local st missing
  st="$(derive_gate "node_runtime npm frontend_deps")"
  missing="$(gate_missing_list "node_runtime npm frontend_deps")"
  if [ "$st" = "available" ]; then
    add_cap "frontend_gate" "$st" "gates the frontend verify profile (typecheck, lint, unit, token contract, build)"
  else
    add_cap "frontend_gate" "$st" "frontend verify profile not ready — ${missing}"
  fi
}

cap_backend_gate() {
  local st missing
  st="$(derive_gate "uv_runtime backend_deps database")"
  missing="$(gate_missing_list "uv_runtime backend_deps database")"
  if [ "$st" = "available" ]; then
    add_cap "backend_gate" "$st" "gates the backend verify profile (system check, migration drift, full test suite)"
  else
    add_cap "backend_gate" "$st" "backend verify profile not ready — ${missing}"
  fi
}

cap_quick_gate() {
  local prereqs="node_runtime npm frontend_deps uv_runtime backend_deps" st missing
  st="$(derive_gate "$prereqs")"
  missing="$(gate_missing_list "$prereqs")"
  if [ "$st" = "available" ]; then
    add_cap "quick_gate" "$st" "gates the quick verify profile (no database required)"
  else
    add_cap "quick_gate" "$st" "quick verify profile not ready — ${missing}"
  fi
}

cap_e2e_gate() {
  local prereqs="node_runtime npm frontend_deps playwright_runtime chromium_launch database"
  local st missing consent
  st="$(derive_gate "$prereqs")"
  missing="$(gate_missing_list "$prereqs")"
  if [ "${FG_ALLOW_E2E_RESET:-0}" = "1" ]; then consent="FG_ALLOW_E2E_RESET is set"; else consent="FG_ALLOW_E2E_RESET is not set"; fi
  if [ "$st" = "available" ]; then
    add_cap "e2e_gate" "$st" "E2E environment ready (${consent}); running E2E still requires explicit opt-in because it resets the fg_e2e schema — the doctor never sets it"
  else
    add_cap "e2e_gate" "$st" "E2E not ready — ${missing} (${consent}); a blocked browser is NOT a successful E2E verification; the doctor never touches fg_e2e"
  fi
}

# ------------------------------------------------------------------ output ---

usage() {
  cat <<EOF
Usage:
  ./scripts/agent-doctor.sh             human-readable capability matrix
  ./scripts/agent-doctor.sh --json      stable machine-readable JSON
  ./scripts/agent-doctor.sh --help      this help

Read-only environment doctor: it never runs tests, never starts persistent
services or browsers, never installs dependencies, and never mutates the
working tree or any database (database access is connect + SELECT 1 only).

Status values:
  available    capability present and working in this environment
  unavailable  required component/dependency missing
  blocked      component present, but unusable here (policy, failing launch,
               auth, network) — a known blocker, distinct from missing deps
  unknown      not determinable without mutation or extra context

Optional capabilities:
  agent_observability is reported but does NOT gate the result/exit code;
  it is excluded from "required" unless FG_DOCTOR_REQUIRE_OBSERVABILITY=1.
  A missing optional collector never turns a healthy product environment
  into a failed doctor result.

Exit codes:
  0  all required capabilities available
  1  diagnosis completed; >=1 required capability blocked/unavailable/unknown
  2  usage error
  3  internal doctor failure

Note: a blocked browser never counts as a successful E2E verification.
EOF
}

on_failure() {
  printf 'agent-doctor: ERROR: internal failure (line %s) — see stderr above\n' "$1" >&2
  exit 3
}

print_human() {
  local i
  printf 'FG environment doctor (read-only: no tests, no installs, no services, no data changes)\n'
  printf 'Repo: %s  branch=%s head=%s writable=%s\n' \
    "$REPO_ROOT" "${REPO_BRANCH:-?}" "${REPO_HEAD:-?}" \
    "$([ "$REPO_WRITABLE" = "true" ] && printf yes || printf no)"
  printf 'Platform: %s %s\n\n' "$PLATFORM" "$ARCH"
  printf '%-22s %-12s %s\n' "CAPABILITY" "STATUS" "DETAIL"
  for i in "${!CAP_NAMES[@]}"; do
    printf '%-22s %-12s %s\n' "${CAP_NAMES[$i]}" "${CAP_STATUSES[$i]}" "${CAP_DETAILS[$i]}"
  done
  printf '\n'
  printf 'Summary: %d capabilities — %s available, %s blocked, %s unavailable, %s unknown\n' \
    "${#CAP_NAMES[@]}" "$(count_status available)" "$(count_status blocked)" \
    "$(count_status unavailable)" "$(count_status unknown)"
  local n_required n_required_avail
  n_required_avail="$(count_status_required available)"
  n_required=$(( n_required_avail + $(count_status_required blocked) + $(count_status_required unavailable) + $(count_status_required unknown) ))
  if [ "$n_required_avail" -eq "$n_required" ]; then
    printf 'Result: OK (exit code 0)%s\n' "$(optional_note)"
  else
    printf 'Result: DEGRADED — one or more required capabilities are not fully available (exit code 1)%s\n' "$(optional_note)"
  fi
}

optional_note() {
  local i missing=""
  for i in "${!CAP_NAMES[@]}"; do
    if is_optional_cap "${CAP_NAMES[$i]}" && [ "${CAP_STATUSES[$i]}" != "available" ]; then
      if [ -n "$missing" ]; then missing="$missing, "; fi
      missing="${CAP_NAMES[$i]}(${CAP_STATUSES[$i]})"
    fi
  done
  if [ -n "$missing" ]; then
    printf ' [optional capabilities not fully available: %s — they do not gate this result]' "$missing"
  fi
  return 0
}

optional_caps_json() {
  local out="" i q='"'
  for i in "${!CAP_NAMES[@]}"; do
    if is_optional_cap "${CAP_NAMES[$i]}"; then
      if [ -n "$out" ]; then out="$out, "; fi
      out="${out}${q}${CAP_NAMES[$i]}${q}"
    fi
  done
  printf '%s' "$out"
}

print_json() {
  local i sep n_total n_avail n_block n_unavail n_unknown n_required n_required_avail overall
  n_total="${#CAP_NAMES[@]}"
  n_avail="$(count_status available)"
  n_block="$(count_status blocked)"
  n_unavail="$(count_status unavailable)"
  n_unknown="$(count_status unknown)"
  n_required_avail="$(count_status_required available)"
  n_required=$(( n_required_avail + $(count_status_required blocked) + $(count_status_required unavailable) + $(count_status_required unknown) ))
  if [ "$n_required_avail" -eq "$n_required" ]; then overall="ok"; else overall="degraded"; fi
  printf '{\n'
  printf '  "schema_version": %d,\n' "$SCHEMA_VERSION"
  printf '  "tool": "%s",\n' "$(json_escape "$DOCTOR_TOOL")"
  printf '  "repo": {\n'
  printf '    "root": "%s",\n' "$(json_escape "$REPO_ROOT")"
  printf '    "branch": "%s",\n' "$(json_escape "${REPO_BRANCH:-}")"
  printf '    "head": "%s",\n' "$(json_escape "${REPO_HEAD:-}")"
  printf '    "writable": %s\n' "$REPO_WRITABLE"
  printf '  },\n'
  printf '  "environment": {\n'
  printf '    "platform": "%s",\n' "$(json_escape "$PLATFORM")"
  printf '    "arch": "%s"\n' "$(json_escape "$ARCH")"
  printf '  },\n'
  printf '  "capabilities": [\n'
  for i in "${!CAP_NAMES[@]}"; do
    sep=","
    if [ "$i" -eq $((n_total - 1)) ]; then sep=""; fi
    printf '    {"name": "%s", "status": "%s", "detail": "%s"}%s\n' \
      "$(json_escape "${CAP_NAMES[$i]}")" \
      "$(json_escape "${CAP_STATUSES[$i]}")" \
      "$(json_escape "${CAP_DETAILS[$i]}")" \
      "$sep"
  done
  printf '  ],\n'
  printf '  "optional_capabilities": [%s],\n' "$(optional_caps_json)"
  printf '  "summary": {\n'
  printf '    "total": %d,\n' "$n_total"
  printf '    "available": %d,\n' "$n_avail"
  printf '    "blocked": %d,\n' "$n_block"
  printf '    "unavailable": %d,\n' "$n_unavail"
  printf '    "unknown": %d,\n' "$n_unknown"
  printf '    "overall": "%s"\n' "$overall"
  printf '  }\n'
  printf '}\n'
}

main() {
  local mode="human"
  if [ "$#" -gt 1 ]; then
    usage >&2
    exit 2
  fi
  case "${1:-}" in
    '')           mode="human" ;;
    --help|-h|help) usage; exit 0 ;;
    --json)       mode="json" ;;
    *)
      usage >&2
      exit 2
      ;;
  esac

  PLATFORM="$(uname -s 2>/dev/null || printf unknown)"
  ARCH="$(uname -m 2>/dev/null || printf unknown)"
  REPO_BRANCH=""
  REPO_HEAD=""
  REPO_WRITABLE="false"

  cap_repo_workspace
  cap_node_runtime
  cap_npm
  cap_uv_runtime
  cap_python_runtime
  cap_frontend_deps
  cap_backend_deps
  cap_database
  cap_frontend_gate
  cap_backend_gate
  cap_quick_gate
  cap_playwright_runtime
  cap_chromium_launch
  cap_e2e_gate
  cap_network
  cap_agent_observability

  if [ "$mode" = "json" ]; then
    print_json
  else
    print_human
  fi

  local n_required n_required_avail
  n_required_avail="$(count_status_required available)"
  n_required=$(( n_required_avail + $(count_status_required blocked) + $(count_status_required unavailable) + $(count_status_required unknown) ))
  if [ "$n_required_avail" -eq "$n_required" ]; then
    exit 0
  fi
  exit 1
}

if [ "${FG_DOCTOR_SOURCE_ONLY:-0}" != "1" ]; then
  trap 'on_failure $LINENO' ERR
  main "$@"
fi
