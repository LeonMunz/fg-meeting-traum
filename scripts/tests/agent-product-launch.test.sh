#!/usr/bin/env bash
#
# Tests for scripts/agent-product-launch (automatic product-session
# observability lifecycle: transparent ACP prompt-turn relay + one-time
# host integration).
#
# Run:  bash scripts/tests/agent-product-launch.test.sh
#
# The observability unit is the ACP session/prompt TURN (not the ACP
# session, not the ACP process): ACP defines the prompt turn as the
# execution boundary (session/prompt request -> foreground agent work
# -> the matching session/prompt response carrying a stopReason).
# Lucid keeps ACP sessions alive indefinitely, so session/close is NOT
# a run boundary — it is cleanup only (an unexpectedly open turn
# finalizes as interrupted, the session state is released). The ACP
# sessionId stays a persistent grouping dimension; every prompt turn
# gets its own distinct run. ACP process exit is only a fallback
# boundary (an active turn finalizes as interrupted).
#
# Coverage:
#   * help / usage / exit codes
#   * prompt-turn lifecycle (scenario driver + fake long-lived ACP
#     server + real collector): session open starts NO run; prompt A
#     -> run A (+ mapping for the active turn); response A -> run A
#     finalizes (graceful, end Git evidence, ledger, mapping released,
#     collector stopped); the session STAYS ALIVE without any close;
#     prompt B in the same session -> distinct run B; exact
#     request-id correlation (a forged wrong-id response never
#     finalizes; the exact-id one does; a late duplicate is a bounded
#     no-op); session close during an active turn -> interrupted
#     cleanup; duplicate/unknown closes harmless; no run for a
#     session-less process or a session without a prompt; prompt
#     content never persisted; fragmented stream stays valid ACP
#   * crash / signal fallbacks: server crash DURING an active prompt
#     -> interrupted finalization, no orphan collector, exit status
#     kept; SIGTERM mid-turn -> forwarded, interrupted finalization,
#     exit 143; child exit codes preserved (with and without an active
#     turn)
#   * concurrency: a foreign live capture -> the prompt turn fails
#     open (never attached); after the foreign run ends, the SAME
#     session's next prompt is captured (distinct run); the
#     already_running prompt does NOT wait for a readiness it does
#     not own
#   * collector readiness ordering (t18): for a capturable prompt the
#     collector is confirmed accepting OTLP BEFORE the prompt bytes are
#     forwarded (runtime observation at prompt receipt: port-accepting
#     probe + exact wire-bytes hash + exactly-once); bounded startup
#     delay holds the prompt until readiness; collector exit-before-ready
#     and alive-never-ready fail bounded, fail-open, no run, no mapping
#   * run identity: inherited stale FG_AGENT_RUN_ID dropped; the
#     active-turn mapping (CODEX_SESSION_ID) resolves exactly the
#     turn's run — including over a newer live run (no newest-run
#     guessing); explicit FG_AGENT_RUN_ID still overrides; the captured
#     conversation identity (ACP session id = native Codex conversation
#     id) is persisted into the run manifest at start time and survives
#     finalization + mapping release (ledger carries it)
#   * verification correlation: agent-verify --summary-json attributes
#     to the ACTIVE TURN's run via the mapping; the turn-finalization
#     ledger consumes the correlated summary
#   * fail-open: broken collector -> the prompt turn is uncaptured,
#     stream intact, bounded warning, no secret/env leakage
#   * session identity across re-opens: session/resume + session/load
#     (existing session re-opened as a fresh ROOT ACP session) and
#     session/fork (response carries the new sessionId) — every
#     prompt turn gets its own distinct run; idle close finalizes
#     nothing; the relay event log records the lifecycle chain, never
#     the prompt
#   * mapping write failure: run starts live, turn uncaptured, bounded
#     diagnostic recorded, the prompt response still finalizes the run
#     gracefully
#   * NDJSON wire (the real ACP stdio format): prompt-turn observation
#     on newline-delimited traffic (no framer bypass); fragmented byte
#     reads; several JSON-RPC lines in one write; an oversized line
#     skipped for that line only (bounded diagnostic, no payload
#     leakage, observation resumes); a malformed line forwarded
#     unchanged without killing observation
#   * framer unit tests (no collector required): the wire-observer
#     contract at byte level (fragmentation, multi-line reads,
#     per-line skip boundary, CRLF, blank lines, long lines)
#   * live shadow-warning unit tests (no collector required): the
#     pathological-generation shadow warning (diagnostic only; at most
#     one bounded relay event per captured turn) — incident shape,
#     1800 s boundary, segment/completion semantics, tool /
#     non-reasoning negatives, foreign-telemetry isolation, one-shot,
#     rotation (rename-preserving inode offsets), incomplete trailing
#     line, read/parsing failure (no error storm), relay event format,
#     plus a read-only replay of the stored incident and representative
#     captured runs when local artifacts are present
#   * opt-out: FG_AGENT_OBSERVABILITY=0 -> direct launch, no relay, no
#     capture, no diagnostics
#   * doctor snapshot knob (FG_OBS_NO_DOCTOR_SNAPSHOT)
#   * start --json machine-readable contract (control surface)
#   * one-time install: backup/trampoline/config, idempotency, status,
#     trampoline end-to-end (real ACP session through the installed
#     trampoline), fallback when the wrapper is missing, uninstall
#     (byte-exact restore), recursion guards
#
# Collector-dependent tests run only when a collector binary is present
# and the test OTLP port is free (otherwise SKIPPED, like the
# observability suite). All runtime artifacts stay in a temp dir; the
# real .artifacts/agent-runs, the default OTLP port, and the product
# registration are never touched (the scenarios run on an isolated test
# port, FG_PL_TEST_PORT, default 4319).

set -Eeuo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WRAPPER="$REPO_ROOT/scripts/agent-product-launch"
OBSCTL="$REPO_ROOT/scripts/agent-observability"
DRIVER="$REPO_ROOT/scripts/tests/fixtures/acp-scenario-driver.py"
FAKE_SERVER="$REPO_ROOT/scripts/tests/fixtures/acp-fake-server.py"

PASS=0
FAIL=0
FAILED=()
SKIP=0
SKIPPED=()

ok()   { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); FAILED+=("$1"); printf 'FAIL %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); SKIPPED+=("$1"); printf 'skip %s\n' "$1"; }

CAP_OUT=""
RC=0
run_cmd() {
  RC=0
  set +e
  CAP_OUT="$("$@" 2>&1)" || RC=$?
  set -e
}
expect_rc() { if [ "$2" -eq "$3" ]; then ok "$1"; else bad "$1 (expected rc=$2, got rc=$3: ${CAP_OUT:0:200})"; fi; }
expect_contains() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 (missing: $3)" ;; esac; }
expect_not_contains() { case "$2" in *"$3"*) bad "$1 (found: $3)" ;; *) ok "$1" ;; esac; }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected: $2 | actual: $3)"; fi; }
expect_file() { if [ -f "$2" ]; then ok "$1"; else bad "$1 (missing: $2)"; fi; }
expect_dir() { if [ -d "$2" ]; then ok "$1"; else bad "$1 (missing: $2)"; fi; }
expect_no_file() { if [ -e "$2" ]; then bad "$1 (exists: $2)"; else ok "$1"; fi; }

probe_py() {
  if [ -x "$REPO_ROOT/apps/api/.venv/bin/python" ]; then
    printf '%s' "$REPO_ROOT/apps/api/.venv/bin/python"
  else
    printf '%s' "python3"
  fi
}
PY="$(probe_py)"

# --------------------------------------------------- hermetic environment --
# The harness may itself run inside a real product session, whose
# environment carries wrapper markers (recursion guard), a stale run id,
# and product session identity. Direct (non-scenario) tests must not be
# affected by any of that: strip the markers here; scenarios control
# their environment explicitly through the driver's base_env().
unset FG_PRODUCT_OBS_IN_WRAPPER FG_PRODUCT_LAUNCH_STATE_DIR \
      FG_PRODUCT_LAUNCH_ENTRYPOINT FG_PRODUCT_LAUNCH_DELEGATE \
      FG_PRODUCT_SESSION_MAP_DIR FG_PRODUCT_RELAY_OBSCTL \
      FG_OBS_RUNS_DIR FG_OBS_PORT CODEX_HOME CODEX_PATH \
      CODEX_SESSION_ID FG_PRODUCT_CODEX_HOME FG_AGENT_RUN_ID 2>/dev/null || true

TEST_PORT="${FG_PL_TEST_PORT:-4319}"

# --------------------------------------------------------------- fixtures --

T="$(mktemp -d "${TMPDIR:-/tmp}/fg-product-launch-test.XXXXXX")"
cleanup() {
  # best-effort: stop anything still running in the isolated test runs dir
  local d
  for d in "$T"/scenario-*; do
    [ -d "$d" ] || continue
    FG_OBS_RUNS_DIR="$d/runs" FG_OBS_PORT="$TEST_PORT" \
      "$OBSCTL" stop >/dev/null 2>&1 || true
  done
  FG_OBS_RUNS_DIR="$T/runs" FG_OBS_PORT="$TEST_PORT" \
    "$OBSCTL" stop >/dev/null 2>&1 || true
  chmod -R u+rwX "$T" 2>/dev/null || true
  rm -rf "$T"
}
trap cleanup EXIT

# Fake broken collector (test fixture): passes FG_OTELCOL resolution
# (it is executable) but fails `validate` fast — a deterministic,
# process-free collector failure for fail-open tests.
BROKEN_OTELCOL="$T/broken-otelcol"
printf '#!/bin/sh\nprintf "fake broken collector (test fixture)\\n" >&2\nexit 3\n' > "$BROKEN_OTELCOL"
chmod 755 "$BROKEN_OTELCOL"

# make_fake_bin <dir> — restricted PATH for agent-verify scenario runs
# (mirrors scripts/tests/agent-verify.test.sh): the phase tools (git,
# npm, uv) are stubbed; the handful of utilities agent-verify needs are
# symlinked to the real ones.
make_fake_bin() {
  local dir="$1" tool target
  mkdir -p "$dir"
  for tool in bash mktemp date dirname mv rm; do
    target="$(command -v "$tool" 2>/dev/null || true)"
    if [ -n "$target" ]; then ln -sf "$target" "$dir/$tool"; fi
  done
  printf '#!/bin/bash\nexit 0\n' >"$dir/git"
  printf '#!/bin/bash\nexit 0\n' >"$dir/npm"
  printf '#!/bin/bash\nexit 0\n' >"$dir/uv"
  chmod +x "$dir/git" "$dir/npm" "$dir/uv"
}
FAKE_BIN="$T/fake-bin"
make_fake_bin "$FAKE_BIN"

collector_present() {
  if command -v otelcol >/dev/null 2>&1; then return 0; fi
  if ls "$REPO_ROOT/.artifacts/agent-observability/otelcol"/*/otelcol >/dev/null 2>&1; then return 0; fi
  return 1
}
port_free() {
  "$PY" - "$TEST_PORT" <<'PYEOF'
import socket, sys
s = socket.socket()
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
    sys.exit(0)
except OSError:
    sys.exit(1)
finally:
    s.close()
PYEOF
}

E2E_AVAILABLE=0
if collector_present && port_free; then
  E2E_AVAILABLE=1
fi
if [ "$E2E_AVAILABLE" -eq 0 ]; then
  skip "collector/test-port unavailable — collector-dependent lifecycle tests SKIPPED"
fi

# run_scenario <name> <scenario> [extra driver args...]
# Each scenario gets its own isolated workdir (runs/map/port usage is
# per-scenario; stale artifacts must never leak between scenarios).
# The driver's ok/FAIL lines are forwarded into this suite's counters.
run_scenario() {
  local name="$1" scn="$2"
  shift 2
  local wd="$T/scenario-$scn"
  mkdir -p "$wd"
  CAP_OUT=""
  RC=0
  set +e
  CAP_OUT="$("$PY" "$DRIVER" "$scn" --repo "$REPO_ROOT" --workdir "$wd" "$@" 2>&1)" || RC=$?
  set -e
  local line
  while IFS= read -r line; do
    case "$line" in
      ok\ \ \ *) ok "${name} ${line#ok   }" ;;
      FAIL\ *)   bad "${name} ${line#FAIL }" ;;
      *) : ;;
    esac
  done <<< "$CAP_OUT"
  if [ "$RC" -ne 0 ] && [ "$FAIL" -gt 0 ]; then
    # failure detail already recorded per check; keep the tail for context
    printf '       (scenario %s rc=%s)\n' "$scn" "$RC" >&2
  fi
}

# ------------------------------------------------------------- t01 usage --
run_cmd bash "$WRAPPER" help
expect_rc "t01a help exits 0" 0 "$RC"
expect_contains "t01b help documents the prompt-turn lifecycle" "$CAP_OUT" "session/prompt"
run_cmd env -u FG_PRODUCT_LAUNCH_DELEGATE FG_PRODUCT_LAUNCH_STATE_DIR="$T/state-none" bash "$WRAPPER" install x
expect_rc "t01c management command rejects extra args" 2 "$RC"
run_cmd env -u FG_PRODUCT_LAUNCH_DELEGATE FG_PRODUCT_LAUNCH_STATE_DIR="$T/state-none" bash "$WRAPPER" launch foo
expect_rc "t01d launch without delegate exits 2" 2 "$RC"

# ----------------------------------- t02 prompt-turn lifecycle (the core) --
if [ "$E2E_AVAILABLE" -eq 1 ]; then
  run_scenario "t02" prompt-turn
  run_scenario "t02" id-correlation
  run_scenario "t02" close-cleanup
fi

# --------------------------------------------------- t03 crash / signal -----
if [ "$E2E_AVAILABLE" -eq 1 ]; then
  run_scenario "t03" crash-interrupted
  run_scenario "t03" signal-terminated
  run_scenario "t03" exit-status
fi

# --------------------------------------------------------- t04 no-session ---
if [ "$E2E_AVAILABLE" -eq 1 ]; then
  run_scenario "t04" no-session
fi

# --------------------------------------------------------- t05 concurrency --
if [ "$E2E_AVAILABLE" -eq 1 ]; then
  run_scenario "t05" concurrency
fi

# -------------------------------------------------- t06 verify correlation --
if [ "$E2E_AVAILABLE" -eq 1 ]; then
  run_scenario "t06" verify-correlation --fake-bin "$FAKE_BIN"
fi

# ---------------------------------------------------- t07 opt-out / stale ---
if [ "$E2E_AVAILABLE" -eq 1 ]; then
  run_scenario "t07" opt-out
  run_scenario "t07" stale-runid
fi

# -------------------------------------------------------------- t08 fail-open --
if [ "$E2E_AVAILABLE" -eq 1 ]; then
  FG_PL_BROKEN_OTELCOL="$BROKEN_OTELCOL" run_scenario "t08" fail-open
fi

# ------------------------------------------- t15 session re-opens / map fail --
if [ "$E2E_AVAILABLE" -eq 1 ]; then
  run_scenario "t15" session-reopen
  run_scenario "t15" map-fail
fi

# ---------------------------------------------------- t16 NDJSON wire ----
# The real ACP stdio regression: stable v1 ACP is newline-delimited JSON.
# The old LSP-only observer bypassed the whole stream on this traffic
# (framer-bypass … headers-oversized) and never saw session/new.
if [ "$E2E_AVAILABLE" -eq 1 ]; then
  run_scenario "t16" ndjson-wire
fi

# ------------------------------------- t18 collector readiness ordering --
# The ordering invariant: for a capturable prompt, the collector is
# CONFIRMED ACCEPTING on its loopback OTLP endpoint BEFORE the prompt
# bytes are forwarded to the Codex child. The fake server observes the
# runtime order directly (live port-accepting probe at prompt receipt,
# sha256 of the exact wire line, exactly-once receipt, and a
# first-request OTLP event that is only capturable if readiness
# genuinely precedes forwarding — see the scenario docstrings in
# acp-scenario-driver.py, ready-ordering / ready-delayed /
# ready-fail-exit / ready-fail-timeout).
if [ "$E2E_AVAILABLE" -eq 1 ]; then
  REAL_OTELCOL=""
  if command -v otelcol >/dev/null 2>&1; then
    REAL_OTELCOL="$(command -v otelcol)"
  else
    REAL_OTELCOL="$(ls "$REPO_ROOT/.artifacts/agent-observability/otelcol"/*/otelcol 2>/dev/null | head -n1)"
  fi
  if [ -n "$REAL_OTELCOL" ] && [ -x "$REAL_OTELCOL" ]; then
    # Slow collector: a bounded, deliberate delay before the real
    # collector binds the port (Case B).
    SLOW_OTELCOL="$T/slow-otelcol"
    {
      printf '#!/bin/sh\n'
      printf 'if [ "$1" = "validate" ]; then exit 0; fi\n'
      printf 'if [ "$1" = "--version" ]; then exec "$SLOW_REAL" --version; fi\n'
      printf 'sleep "${SLOW_COLLECTOR_DELAY:-3}"\n'
      printf 'exec "$SLOW_REAL" "$@"\n'
    } > "$SLOW_OTELCOL"
    chmod 755 "$SLOW_OTELCOL"
    # Collector that passes validate but EXITS before readiness (Case C).
    FAILEXIT_OTELCOL="$T/fail-exit-otelcol"
    {
      printf '#!/bin/sh\n'
      printf 'if [ "$1" = "validate" ]; then exit 0; fi\n'
      printf 'if [ "$1" = "--version" ]; then exit 1; fi\n'
      printf 'sleep 0.3\n'
      printf 'exit 7\n'
    } > "$FAILEXIT_OTELCOL"
    chmod 755 "$FAILEXIT_OTELCOL"
    # Collector that stays ALIVE but never binds the port (Case D).
    NEVERREADY_OTELCOL="$T/never-ready-otelcol"
    {
      printf '#!/bin/sh\n'
      printf 'if [ "$1" = "validate" ]; then exit 0; fi\n'
      printf 'if [ "$1" = "--version" ]; then exit 1; fi\n'
      printf 'sleep 300\n'
    } > "$NEVERREADY_OTELCOL"
    chmod 755 "$NEVERREADY_OTELCOL"

    run_scenario "t18" ready-ordering
    FG_PL_SLOW_OTELCOL="$SLOW_OTELCOL" FG_PL_REAL_OTELCOL="$REAL_OTELCOL" \
      FG_PL_SLOW_DELAY=3 run_scenario "t18" ready-delayed
    FG_PL_FAILEXIT_OTELCOL="$FAILEXIT_OTELCOL" run_scenario "t18" ready-fail-exit
    FG_PL_NEVERREADY_OTELCOL="$NEVERREADY_OTELCOL" run_scenario "t18" ready-fail-timeout
  fi
fi

# ------------------------------------------------- t17 framer unit tests --
# The wire-observer unit tests need no collector: they feed raw byte
# chunks straight into the relay's NdjsonFramer and assert on the
# observer callbacks (see scripts/tests/fixtures/ndjson-framer-units.py).
RC=0
set +e
CAP_OUT="$("$PY" "$REPO_ROOT/scripts/tests/fixtures/ndjson-framer-units.py" 2>&1)" || RC=$?
set -e
while IFS= read -r line; do
  case "$line" in
    ok\ \ \ *) ok "t17 ${line#ok   }" ;;
    FAIL\ *)   bad "t17 ${line#FAIL }" ;;
    *) : ;;
  esac
done <<< "$CAP_OUT"
expect_rc "t17z framer unit tests exit 0" 0 "$RC"

# ------------------------------- t19 live shadow-warning unit tests ----
# The live pathological-generation shadow warning (diagnostic only, one
# bounded relay event per captured turn) is unit-tested WITHOUT a
# collector: synthetic timestamped JSONL telemetry drives the
# incremental raw-log reader and the predicate with injected time
# (cases A-K plus the relay event-format contract; the byte-transparent
# ACP stream of case L is covered by the scenario tests above), and the
# stored incident (when local artifacts are present) is replayed
# READ-ONLY through the same predicate (see
# scripts/tests/fixtures/shadow-warning-units.py).
RC=0
set +e
CAP_OUT="$("$PY" "$REPO_ROOT/scripts/tests/fixtures/shadow-warning-units.py" 2>&1)" || RC=$?
set -e
while IFS= read -r line; do
  case "$line" in
    ok\ \ \ *) ok "t19 ${line#ok   }" ;;
    FAIL\ *)   bad "t19 ${line#FAIL }" ;;
    *) : ;;
  esac
done <<< "$CAP_OUT"
expect_rc "t19z shadow-warning unit tests exit 0" 0 "$RC"

# --------------------------------------------------------- t09 doctor knob ---
if [ "$E2E_AVAILABLE" -eq 1 ]; then
  run_scenario "t09" doctor-snapshot
fi

# ----------------------------------------------- t10 start --json contract --
if [ "$E2E_AVAILABLE" -eq 1 ]; then
  RC=0
  set +e
  CAP_OUT="$(FG_OBS_RUNS_DIR="$T/runs" FG_OBS_PORT="$TEST_PORT" FG_OBS_NO_DOCTOR_SNAPSHOT=1 \
    env -u CODEX_HOME -u CODEX_PATH -u CODEX_SESSION_ID -u FG_PRODUCT_CODEX_HOME \
      "$OBSCTL" start --json 2>"$T/t10-start.err")" || RC=$?
  set -e
  expect_rc "t10a start --json exits 0" 0 "$RC"
  # The contract is the only document on stdout.
  T10_OK="$("$PY" - "$CAP_OUT" <<'PYCHK'
import json, sys
d = json.loads(sys.argv[1])
assert d["schema_version"] == 1 and d["tool"] == "agent-observability"
assert d["status"] == "started"
assert d["run_id"].startswith("run-") and d["pid"] > 0
print("ok")
PYCHK
)"
  expect_eq "t10b start --json contract valid (started)" "ok" "$T10_OK"
  T10_RID="$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["run_id"])' "$CAP_OUT")"
  expect_dir "t10c run dir created" "$T/runs/$T10_RID"
  # second start --json: idempotent already_running reporting the SAME owner
  RC=0
  set +e
  CAP_OUT="$(FG_OBS_RUNS_DIR="$T/runs" FG_OBS_PORT="$TEST_PORT" FG_OBS_NO_DOCTOR_SNAPSHOT=1 \
    env -u CODEX_HOME -u CODEX_PATH -u CODEX_SESSION_ID -u FG_PRODUCT_CODEX_HOME \
      "$OBSCTL" start --json 2>/dev/null)" || RC=$?
  set -e
  expect_rc "t10d second start --json exits 0 (idempotent)" 0 "$RC"
  T10_OK="$("$PY" - "$CAP_OUT" <<'PYCHK'
import json, sys
d = json.loads(sys.argv[1])
assert d["status"] == "already_running"
print(d["run_id"])
PYCHK
)"
  expect_eq "t10e already_running reports the existing owner's run" "$T10_RID" "$T10_OK"
  run_cmd env FG_OBS_RUNS_DIR="$T/runs" FG_OBS_PORT="$TEST_PORT" env -u CODEX_HOME -u CODEX_SESSION_ID "$OBSCTL" stop
  expect_rc "t10f stop exits 0" 0 "$RC"
  # unknown option still rejected
  run_cmd env FG_OBS_RUNS_DIR="$T/runs" FG_OBS_PORT="$TEST_PORT" "$OBSCTL" start --bogus
  expect_rc "t10g start --bogus still exits 2" 2 "$RC"
fi

# ------------------------------------------------------------- t11 install ---
mkdir -p "$T/state/bin"
cp -p "$FAKE_SERVER" "$T/state/bin/lucid-codex-acp"
chmod 755 "$T/state/bin/lucid-codex-acp"
cp -p "$T/state/bin/lucid-codex-acp" "$T/original-launcher.saved"

run_cmd env FG_PRODUCT_LAUNCH_STATE_DIR="$T/state" FG_PRODUCT_LAUNCH_ENTRYPOINT="$T/state/bin/lucid-codex-acp" bash "$WRAPPER" install
expect_rc "t11a install exits 0" 0 "$RC"
expect_contains "t11b install reports success" "$CAP_OUT" "installed"
EP="$T/state/bin/lucid-codex-acp"
IMPL="$T/state/lucid-codex-acp.impl"
CFG="$T/state/agent-product-launch.json"
case "$(head -c 512 "$EP")" in
  *"# BEGIN fg-meeting-traum agent-product-launch trampoline"*) ok "t11c entrypoint is a trampoline" ;;
  *) bad "t11c entrypoint is a trampoline" ;;
esac
[ -x "$EP" ] && ok "t11d trampoline executable" || bad "t11d trampoline executable"
expect_file "t11e impl backup exists" "$IMPL"
if cmp -s "$T/original-launcher.saved" "$IMPL"; then ok "t11f impl byte-identical to the original"; else bad "t11f impl byte-identical to the original"; fi
expect_file "t11g config exists" "$CFG"
"$PY" -c 'import json,sys
d = json.load(open(sys.argv[1]))
assert d["schema_version"] == 1
assert d["repo_root"] == sys.argv[2]
assert d["entrypoint"] == sys.argv[3]
assert d["delegate"] == sys.argv[4]
' "$CFG" "$REPO_ROOT" "$EP" "$IMPL" 2>/dev/null \
  && ok "t11h config fields correct" || bad "t11h config fields correct"
MD5_BEFORE="$(md5 -q "$EP" 2>/dev/null || true)"
run_cmd env FG_PRODUCT_LAUNCH_STATE_DIR="$T/state" FG_PRODUCT_LAUNCH_ENTRYPOINT="$T/state/bin/lucid-codex-acp" bash "$WRAPPER" install
expect_rc "t11i re-install is idempotent (exit 0)" 0 "$RC"
expect_contains "t11j re-install reports nothing to do" "$CAP_OUT" "already installed"
MD5_AFTER="$(md5 -q "$EP" 2>/dev/null || true)"
expect_eq "t11k re-install leaves the trampoline untouched" "$MD5_BEFORE" "$MD5_AFTER"
run_cmd env FG_PRODUCT_LAUNCH_STATE_DIR="$T/state" FG_PRODUCT_LAUNCH_ENTRYPOINT="$T/state/bin/lucid-codex-acp" bash "$WRAPPER" status
expect_rc "t11l status exits 0 when consistent" 0 "$RC"
expect_contains "t11m status reports consistent" "$CAP_OUT" "installed and consistent"

# ------------------------------------------------- t12 trampoline end-to-end --
if [ "$E2E_AVAILABLE" -eq 1 ]; then
  run_scenario "t12" trampoline-session --launcher "$EP"
  # opt-out through the trampoline
  run_scenario "t12" trampoline-optout --launcher "$EP"
  # trampoline fallback when the wrapper is missing (mutated copy)
  FALL_STATE="$T/state-fallback"
  mkdir -p "$FALL_STATE/bin"
  cp -p "$FAKE_SERVER" "$FALL_STATE/bin/lucid-codex-acp"
  sed "s|$REPO_ROOT|/nonexistent-repo-path|" "$EP" > "$FALL_STATE/bin/lt-trampoline"
  chmod 755 "$FALL_STATE/bin/lt-trampoline"
  T12_FD="$T/scenario-trampoline-fallback"
  mkdir -p "$T12_FD"
  RC=0
  set +e
  CAP_OUT="$(FAKE_LOG="$T12_FD/args.log" FG_PRODUCT_LAUNCH_DELEGATE="$FALL_STATE/bin/lucid-codex-acp" \
    "$PY" "$DRIVER" raw-stream --repo "$REPO_ROOT" --workdir "$T12_FD" \
    --launcher "$FALL_STATE/bin/lt-trampoline" --largs fallback --flag 2>&1)" || RC=$?
  set -e
  expect_rc "t12g trampoline fallback executes the original launcher" 0 "$RC"
  expect_contains "t12h fallback reports the missing wrapper" "$CAP_OUT" "wrapper missing"
  expect_contains "t12i fallback forwards args" "$(cat "$T12_FD/args.log" 2>/dev/null)" "args: [fallback] [--flag]"
fi

# ------------------------------------------------------------- t13 uninstall --
run_cmd env FG_PRODUCT_LAUNCH_STATE_DIR="$T/state" FG_PRODUCT_LAUNCH_ENTRYPOINT="$T/state/bin/lucid-codex-acp" bash "$WRAPPER" uninstall
expect_rc "t13a uninstall exits 0" 0 "$RC"
expect_contains "t13b uninstall reports restore" "$CAP_OUT" "restored"
if cmp -s "$T/original-launcher.saved" "$EP"; then ok "t13c entrypoint byte-identical to the original"; else bad "t13c entrypoint byte-identical to the original"; fi
expect_no_file "t13d config removed" "$CFG"
expect_no_file "t13e impl backup removed" "$IMPL"
run_cmd env FG_PRODUCT_LAUNCH_STATE_DIR="$T/state" FG_PRODUCT_LAUNCH_ENTRYPOINT="$T/state/bin/lucid-codex-acp" bash "$WRAPPER" status
expect_rc "t13f status reports not installed (exit 7)" 7 "$RC"
expect_contains "t13g status explains not installed" "$CAP_OUT" "not installed"
run_cmd env FG_PRODUCT_LAUNCH_STATE_DIR="$T/state" FG_PRODUCT_LAUNCH_ENTRYPOINT="$T/state/bin/lucid-codex-acp" bash "$WRAPPER" uninstall
expect_rc "t13h uninstall is idempotent (exit 0)" 0 "$RC"
expect_contains "t13i idempotent uninstall says nothing to do" "$CAP_OUT" "nothing to do"
# re-install after uninstall (reversible + repeatable)
run_cmd env FG_PRODUCT_LAUNCH_STATE_DIR="$T/state" FG_PRODUCT_LAUNCH_ENTRYPOINT="$T/state/bin/lucid-codex-acp" bash "$WRAPPER" install
expect_rc "t13j re-install after uninstall works" 0 "$RC"
case "$(head -c 512 "$EP")" in
  *"# BEGIN fg-meeting-traum agent-product-launch trampoline"*) ok "t13k trampoline back in place" ;;
  *) bad "t13k trampoline back in place" ;;
esac
run_cmd env FG_PRODUCT_LAUNCH_STATE_DIR="$T/state" FG_PRODUCT_LAUNCH_ENTRYPOINT="$T/state/bin/lucid-codex-acp" bash "$WRAPPER" uninstall
expect_rc "t13l final uninstall restores again" 0 "$RC"
if cmp -s "$T/original-launcher.saved" "$EP"; then ok "t13m entrypoint restored again, byte-identical"; else bad "t13m entrypoint restored again, byte-identical"; fi

# -------------------------------------------------------- t14 recursion guards --
RC=0
set +e
CAP_OUT="$(FG_PRODUCT_LAUNCH_DELEGATE="$WRAPPER" env FG_PRODUCT_LAUNCH_STATE_DIR="$T/state-r" bash "$WRAPPER" launch x 2>&1)" || RC=$?
set -e
expect_rc "t14a delegate == wrapper: recursion guard exit 125" 125 "$RC"
expect_contains "t14b recursion guard message" "$CAP_OUT" "recursion guard"
TRAPFILE="$T/trapfile"
printf '#!/bin/sh\n%s\nexec sleep 0.1\n' "# BEGIN fg-meeting-traum agent-product-launch trampoline" > "$TRAPFILE"
chmod 755 "$TRAPFILE"
RC=0
set +e
CAP_OUT="$(FG_PRODUCT_LAUNCH_DELEGATE="$TRAPFILE" env FG_PRODUCT_LAUNCH_STATE_DIR="$T/state-r" bash "$WRAPPER" launch x 2>&1)" || RC=$?
set -e
expect_rc "t14c delegate is a trampoline: recursion guard exit 125" 125 "$RC"
RC=0
set +e
CAP_OUT="$(FG_PRODUCT_OBS_IN_WRAPPER=1 FG_PRODUCT_LAUNCH_DELEGATE="$FAKE_SERVER" env FG_PRODUCT_LAUNCH_STATE_DIR="$T/state-r" bash "$WRAPPER" launch x 2>&1)" || RC=$?
set -e
expect_rc "t14d nested wrapper env: recursion guard exit 125" 125 "$RC"
RC=0
set +e
CAP_OUT="$(FG_PRODUCT_LAUNCH_DELEGATE="$T/does-not-exist" env FG_PRODUCT_LAUNCH_STATE_DIR="$T/state-r" bash "$WRAPPER" launch x 2>&1)" || RC=$?
set -e
expect_rc "t14e missing delegate exits 2" 2 "$RC"

# ------------------------------------------------------------------ summary --
printf '\nagent-product-launch tests: %s (%d passed, %d failed, %d skipped)\n' \
  "$( [ "$FAIL" -eq 0 ] && printf 'PASS' || printf 'FAIL' )" \
  "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf 'failed:\n'
  for f in "${FAILED[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
exit 0
