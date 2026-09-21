#!/usr/bin/env bash
#
# Tests for scripts/agent-observability (local agent trace capture).
#
# Run:  bash scripts/tests/agent-observability.test.sh
#
# Coverage:
#   * usage / exit codes
#   * `config` output contract (loopback endpoint, log_user_prompt=false,
#     the "cannot live in repo config" rationale)
#   * gitignore coverage of all runtime artifact paths
#   * `status` (human + JSON) read-only, deterministic, works without collector
#   * non-mutation of the working tree
#   * collector config template: sanitization statements + loopback-only
#   * pins.json integrity (version + sha256 per platform)
#   * manifest.py: seed/finalize/summary, interrupted-run safety
#     + captured conversation identity (persisted at seed time; fail-safe
#     null for manual starts and invalid values; survives finalize)
#   * probe client usage contract
#   * CODEX_HOME/CODEX_PATH resolution: unset-env discovery, explicit
#     authority, invalid/ambiguous fail-closed (deterministic, sandbox-safe)
#   * ACP probe-client contract: session/prompt params match the exact
#     codex-acp 1.7.0 schema (fake-agent fixture, deterministic)
#   * collector-dependent e2e (start/stop idempotency + fake-secret
#     sanitization + doctor): executed only when a collector binary is
#     present and no capture is already running; otherwise SKIPPED
#   * Run Ledger (ledger.py + agent-observability ledger/annotate):
#     deterministic normalization of a synthetic capture (fixture OTel +
#     real manifest seed/finalize in a temp git repo), idempotency,
#     activity/timing/token metrics, git/WIP evidence, failures without
#     invented classifications, explicit verification correlation
#     (agentRunId match/mismatch), doctor evidence, human annotations,
#     privacy (dropped-key values never reach the ledger), dedup identity
#     (distinct paired records kept, exact copies collapsed), missing
#     telemetry -> null + gap codes, malformed manifest -> clear failure,
#     captured conversation identity (schema v3): clean single-conversation
#     run unchanged (Case A), captured + foreign scoping with explicit
#     activity.foreign reporting (Cases B/C incl. metrics datapoint
#     attribution), missing identity -> aggregate + explicit
#     captured_conversation_unknown gap (Case D), historical incident
#     reconstruction (Case F); pathological run diagnostics (schema v4):
#     explicit deterministic signals with observed-value evidence,
#     diagnostic-only (no termination, no budget changes), incident
#     shape detected (Case A), short no-tool response not flagged
#     (Case B), healthy long engineering turn not flagged (Case C),
#     tool-heavy failed run exposes only the failure signal (Case D),
#     extreme foreign telemetry never changes the captured diagnosis
#     (Case E), byte-identical re-normalization (Case F), incident
#     replay via the established forensic fixture (Case G)
#
set -Eeuo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OBS="$REPO_ROOT/scripts/agent-observability"
TEMPLATE="$REPO_ROOT/scripts/observability/otelcol-local.yaml"
PINS="$REPO_ROOT/scripts/observability/pins.json"
MANIFEST_PY="$REPO_ROOT/scripts/observability/manifest.py"
PROBE_CLIENT="$REPO_ROOT/scripts/observability/acp-probe-client.mjs"

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
expect_no_file() { if [ -e "$2" ]; then bad "$1 (exists: $2)"; else ok "$1"; fi; }

probe_py() {
  if [ -x "$REPO_ROOT/apps/api/.venv/bin/python" ]; then
    printf '%s' "$REPO_ROOT/apps/api/.venv/bin/python"
  else
    printf '%s' "python3"
  fi
}
PY="$(probe_py)"

collector_present() {
  if command -v otelcol >/dev/null 2>&1; then return 0; fi
  if ls "$REPO_ROOT/.artifacts/agent-observability/otelcol"/*/otelcol >/dev/null 2>&1; then return 0; fi
  return 1
}
capture_running() {
  bash "$OBS" status --json 2>/dev/null \
    | "$PY" -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d["running"]["state"]=="running" else 1)'
}

# Run the control surface with the product-identity environment isolated so
# tests are deterministic and never touch the real product registration or the
# host's live product env: CODEX_HOME / CODEX_PATH / CODEX_SESSION_ID /
# FG_PRODUCT_CODEX_HOME are unset and FG_PRODUCT_RUNTIME_FILE points at the
# given (temp) path. The command may itself lead with VAR=val assignments
# (e.g. FG_PRODUCT_CODEX_HOME=...) which override the unset above.
obs_env() { # obs_env <FG_PRODUCT_RUNTIME_FILE> <cmd...>
  local rt="$1"; shift
  env -u CODEX_HOME -u CODEX_PATH -u CODEX_SESSION_ID -u FG_PRODUCT_CODEX_HOME \
      FG_PRODUCT_RUNTIME_FILE="$rt" "$@"
}
# A temp registration file (left nonexistent -> not_registered) shared by the
# product-identity tests so they are deterministic and never clobber the real
# .artifacts/agent-observability/product-runtime.json.
TESTRT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fg-obs-testrt.XXXXXX")"
TESTRT="$TESTRT_DIR/product-runtime.json"

# ------------------------------------------------------------- t01 usage ----
run_cmd bash "$OBS" --help
expect_rc "t01a --help exits 0" 0 "$RC"
expect_contains "t01b help lists native-probe" "$CAP_OUT" "native-probe"
expect_contains "t01c help documents privacy storage" "$CAP_OUT" ".artifacts"
run_cmd bash "$OBS" --bogus
expect_rc "t01d unknown subcommand exits 2" 2 "$RC"
run_cmd bash "$OBS" start --bogus
expect_rc "t01e start with extra arg exits 2" 2 "$RC"

# ---------------------------------------------------------------- t02 config -
# `config` refuses an actionable destination when the product identity is
# unknown, and targets exactly the product home once it is known.
T02HOME="$(mktemp -d "${TMPDIR:-/tmp}/fg-obs-t02.XXXXXX")/.codex"
mkdir -p "$T02HOME"
printf '[otel]\nlog_user_prompt = false\nexporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "json" } }\ntrace_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/traces", protocol = "json" } }\nmetrics_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/metrics", protocol = "json" } }\n' > "$T02HOME/config.toml"

# (1) no product identity -> non-actionable registration guidance
run_cmd obs_env "$TESTRT" bash "$OBS" config
out="$CAP_OUT"
expect_rc "t02a config (no identity) exits 0" 0 "$RC"
expect_contains "t02b config (no identity) reports UNKNOWN product home" "$out" "UNKNOWN"
expect_contains "t02c config (no identity) explains how to register" "$out" "product-runtime register"
expect_not_contains "t02d config (no identity) prints no actionable destination" "$out" "Add to"
expect_not_contains "t02e config (no identity) never says to edit .codex/config.toml" "$out" "/.codex/config.toml"

# (2) product identity known (explicit override) -> exact destination + [otel]
run_cmd obs_env "$TESTRT" FG_PRODUCT_CODEX_HOME="$T02HOME" bash "$OBS" config
out="$CAP_OUT"
expect_rc "t02f config (identity known) exits 0" 0 "$RC"
expect_contains "t02g config (identity known) targets the product home" "$out" "Add to $T02HOME/config.toml:"
expect_contains "t02h config emits [otel] section" "$out" "[otel]"
expect_contains "t02i config keeps log_user_prompt false" "$out" "log_user_prompt = false"
expect_contains "t02j config points at loopback" "$out" "127.0.0.1:4318"
expect_contains "t02k config overrides metrics exporter" "$out" "metrics_exporter"
expect_contains "t02l config explains repo limitation" "$out" "cannot"
expect_contains "t02m config never claims to edit user config" "$out" "never"
expect_contains "t02n config reports current otel config state" "$out" "current otel config state:"
rm -rf "$(dirname "$T02HOME")"

# ------------------------------------------------------------ t03 gitignore --
run_cmd git -C "$REPO_ROOT" check-ignore -q .artifacts/agent-runs/run-x/raw/logs.jsonl
expect_rc "t03a trace files are git-ignored" 0 "$RC"
run_cmd git -C "$REPO_ROOT" check-ignore -q .artifacts/agent-observability/otelcol/0.161.0/otelcol
expect_rc "t03b collector binary location is git-ignored" 0 "$RC"
run_cmd git -C "$REPO_ROOT" check-ignore -q .artifacts/agent-runs/probe-native-x/capture-manifest.json
expect_rc "t03c manifest is git-ignored" 0 "$RC"

# ------------------------------------------------------------------ t04 status -
# status separates the *product* Codex identity (evidence-based) from the
# generic standalone controller home (informational only).
before_tree="$(git -C "$REPO_ROOT" status --porcelain)"
run_cmd obs_env "$TESTRT" bash "$OBS" status
expect_rc "t04a status (no collector) exits 0" 0 "$RC"
expect_contains "t04b status shows endpoint" "$CAP_OUT" "127.0.0.1:4318"
expect_contains "t04c status labels the product codex home" "$CAP_OUT" "product codex home"
expect_contains "t04d status labels the product otel config" "$CAP_OUT" "product otel config"
expect_contains "t04e status labels the controller/standalone home" "$CAP_OUT" "controller codex home"
run_cmd obs_env "$TESTRT" bash "$OBS" status --json
out="$CAP_OUT"
expect_rc "t04f status --json exits 0" 0 "$RC"
run_cmd "$PY" - "$out" <<'PYCHK'
import json, sys
d = json.loads(sys.argv[1])
assert d["schema_version"] == 1
assert d["tool"] == "agent-observability"
assert d["running"]["state"] in ("running", "stopped")
# product identity (evidence-based; never generic discovery)
assert d["product_codex_home"]["state"] in ("override","product_session","registered","not_registered","corrupt","invalid")
assert "path" in d["product_codex_home"]
assert d["product_otel_config"]["state"] in ("configured","misconfigured","absent","unknown","not_checked")
assert d["product_otel_config"]["local"] in (True, False, None)
# standalone/generic (informational; NOT the product home)
assert d["controller_codex_home"]["state"] in ("discovered","ambiguous","not_found")
assert "path" in d["controller_codex_home"]
assert "controller_codex_version" in d
# the old conflating keys are gone
assert "codex_home" not in d
assert "codex_otel_config" not in d
assert d["endpoint"].startswith("http://127.0.0.1:")
assert set(d["versions"]) == {"codex", "codex_acp", "collector"}
assert isinstance(d["collector"]["available"], bool)
assert isinstance(d["in_product_session"], bool)
PYCHK
expect_rc "t04g status --json schema valid (product vs standalone separated)" 0 "$RC"
run_cmd obs_env "$TESTRT" bash "$OBS" status --json
shape1="$("$PY" -c 'import json,sys; d=json.loads(sys.argv[1]); print(sorted(d.keys()))' "$CAP_OUT")"
run_cmd obs_env "$TESTRT" bash "$OBS" status --json
shape2="$("$PY" -c 'import json,sys; d=json.loads(sys.argv[1]); print(sorted(d.keys()))' "$CAP_OUT")"
expect_eq "t04h status --json structure deterministic" "$shape1" "$shape2"
after_tree="$(git -C "$REPO_ROOT" status --porcelain)"
expect_eq "t04i status did not mutate the working tree" "$before_tree" "$after_tree"

# --- t04x otel config states: synthetic product homes, deterministic ---
# The product [otel] state is judged on the *product* Codex home (here supplied
# as an explicit override), never by generic discovery.
T04X="$(mktemp -d "${TMPDIR:-/tmp}/fg-obs-otelcfg.XXXXXX")"
mkdir -p "$T04X/home-good/.codex" "$T04X/home-badport/.codex" \
         "$T04X/home-nonlocal/.codex" "$T04X/home-prompt/.codex" "$T04X/home-absent/.codex"
for h in good badport nonlocal prompt absent; do
  printf '{}\n' > "$T04X/home-$h/.codex/auth.json"
done
printf '[model]\nmodel = "t"\n\n[otel]\nlog_user_prompt = false\nexporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "json" } }\ntrace_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/traces", protocol = "json" } }\nmetrics_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/metrics", protocol = "json" } }\n' > "$T04X/home-good/.codex/config.toml"
printf '[otel]\nlog_user_prompt = false\nexporter = { otlp-http = { endpoint = "http://127.0.0.1:9999/v1/logs", protocol = "json" } }\n' > "$T04X/home-badport/.codex/config.toml"
printf '[otel]\nlog_user_prompt = false\nexporter = { otlp-http = { endpoint = "http://telemetry.example.com:4318/v1/logs", protocol = "json" } }\n' > "$T04X/home-nonlocal/.codex/config.toml"
printf '[otel]\nlog_user_prompt = true\nexporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "json" } }\n' > "$T04X/home-prompt/.codex/config.toml"
printf '[model]\nmodel = "t"\n' > "$T04X/home-absent/.codex/config.toml"
# judge product_otel_config on an explicit product home (override)
t04x_state() { env -u CODEX_HOME -u CODEX_PATH -u CODEX_SESSION_ID -u FG_PRODUCT_CODEX_HOME \
    FG_PRODUCT_RUNTIME_FILE="$TESTRT" FG_PRODUCT_CODEX_HOME="$1/.codex" \
    bash "$OBS" status --json \
    | "$PY" -c 'import json,sys; d=json.load(sys.stdin)["product_otel_config"]; print(d["state"] + "|" + str(d["local"]))'; }
expect_eq "t04xa all-local [otel] on the product home -> configured" \
  "configured|True" "$(t04x_state "$T04X/home-good")"
expect_eq "t04xb port-mismatched [otel] -> misconfigured" \
  "misconfigured|False" "$(t04x_state "$T04X/home-badport")"
expect_eq "t04xc non-loopback [otel] endpoint -> misconfigured" \
  "misconfigured|False" "$(t04x_state "$T04X/home-nonlocal")"
expect_eq "t04xd log_user_prompt=true -> misconfigured (privacy guard)" \
  "misconfigured|False" "$(t04x_state "$T04X/home-prompt")"
expect_eq "t04xe no [otel] section -> absent" \
  "absent|False" "$(t04x_state "$T04X/home-absent")"
# an invalid (relative) override fails closed -> not_checked
expect_eq "t04xf invalid (relative) product-home override -> not_checked" \
  "not_checked|None" "$(env -u CODEX_HOME -u CODEX_PATH -u CODEX_SESSION_ID -u FG_PRODUCT_CODEX_HOME \
    FG_PRODUCT_RUNTIME_FILE="$TESTRT" FG_PRODUCT_CODEX_HOME="relative/path" \
    bash "$OBS" status --json | "$PY" -c 'import json,sys; d=json.load(sys.stdin)["product_otel_config"]; print(d["state"] + "|" + str(d["local"]))')"
# the misconfigured detail must name only scheme://host:port, never other config
run_cmd env -u CODEX_HOME -u CODEX_PATH -u CODEX_SESSION_ID -u FG_PRODUCT_CODEX_HOME \
    FG_PRODUCT_RUNTIME_FILE="$TESTRT" FG_PRODUCT_CODEX_HOME="$T04X/home-nonlocal/.codex" bash "$OBS" status
expect_contains "t04xg misconfigured detail names the offending endpoint host" "$CAP_OUT" "telemetry.example.com"
expect_not_contains "t04xh misconfigured detail leaks no unrelated config values" "$CAP_OUT" 'model = "t"'
rm -rf "$T04X"

# --------------------------------------------------- t05 collector-dependent --
E2E_DONE=0
E2E_SKIPPED=""
if collector_present; then
  if capture_running; then
    skip "t05e2e a capture is already running — e2e start/stop + fake-secret test SKIPPED (stop it and re-run)"
    E2E_SKIPPED=1
  else
    # doctor first, on a guaranteed-free port
    run_cmd bash "$OBS" doctor --json
    dout="$CAP_OUT"
    expect_rc "t05a doctor --json exits 0" 0 "$RC"
    dstat="$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["status"])' "$dout" 2>/dev/null || true)"
    expect_eq "t05b doctor reports AVAILABLE (e2e loopback capture + sanitization)" "AVAILABLE" "$dstat"
    expect_not_contains "t05c doctor JSON has no fake secret" "$dout" "sk-fake-doctor-9f8e7d6c5b4a"
    if capture_running; then
      skip "t05d doctor must not leave a collector running (unexpected)"
    else
      ok "t05d doctor left no collector running"
    fi

    run_cmd bash "$OBS" start
    expect_rc "t05e start exits 0" 0 "$RC"
    run_cmd bash "$OBS" start
    expect_rc "t05f start is idempotent (already running) exit 0" 0 "$RC"
    ststate="$(bash "$OBS" status --json | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["running"]["state"])')"
    expect_eq "t05g status reports running" "running" "$ststate"

    # fake-secret payload through the real pipeline
    run_cmd bash -c "curl -sS -m 10 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' --data '{\"resourceLogs\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"fg-obs-test\"}}]},\"scopeLogs\":[{\"logRecords\":[{\"severityNumber\":9,\"body\":{\"stringValue\":\"fg-obs-test fake-secret e2e\"},\"attributes\":[{\"key\":\"event.name\",\"value\":{\"stringValue\":\"fg.observability.test\"}},{\"key\":\"test.marker\",\"value\":{\"stringValue\":\"FG_OBS_TEST_MARKER\"}},{\"key\":\"user.email\",\"value\":{\"stringValue\":\"test-secret-email@example.com\"}},{\"key\":\"arguments\",\"value\":{\"stringValue\":\"FAKE=sk-fake-test-1a2b3c4d5e6f\"}},{\"key\":\"originator\",\"value\":{\"stringValue\":\"tester xoxb-fake-test-token-123456\"}}]}]}]}]}' http://127.0.0.1:4318/v1/logs"
    expect_contains "t05h synthetic OTLP payload accepted (HTTP 200)" "$CAP_OUT" "200"
    found=""
    for i in $(seq 1 40); do
      latest="$(bash "$OBS" status --json | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["latest_run"])')"
      if [ -n "$latest" ] && [ -f "$REPO_ROOT/.artifacts/agent-runs/$latest/raw/logs.jsonl" ] \
        && grep -q "FG_OBS_TEST_MARKER" "$REPO_ROOT/.artifacts/agent-runs/$latest/raw/logs.jsonl"; then
        found=1; break
      fi
      sleep 0.25
    done
    [ -n "$found" ] && ok "t05i probe event persisted to raw trace" || bad "t05i probe event persisted to raw trace (marker never appeared)"

    run_cmd bash "$OBS" stop
    expect_rc "t05j stop exits 0" 0 "$RC"
    expect_contains "t05j2 stop auto-reports the ledger path" "$CAP_OUT" "ledger:"
    expect_contains "t05j3 stop auto-reports the evidence gaps" "$CAP_OUT" "evidence gaps"
    run_cmd bash "$OBS" stop
    expect_rc "t05k stop is idempotent (already stopped) exit 0" 0 "$RC"
    ststate="$(bash "$OBS" status --json | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["running"]["state"])')"
    expect_eq "t05l status reports stopped" "stopped" "$ststate"

    latest="$(bash "$OBS" status --json | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["latest_run"])')"
    man="$REPO_ROOT/.artifacts/agent-runs/$latest/capture-manifest.json"
    [ -f "$man" ] && ok "t05m manifest exists after stop" || bad "t05m manifest exists after stop"
    mstat="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["stop_status"])' "$man" 2>/dev/null || true)"
    expect_eq "t05n manifest stop_status is graceful" "graceful" "$mstat"
    # the capture manifest must not carry a seed-time codex version from the
    # controller PATH (explicit null; the ledger attributes it from telemetry)
    mver="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["codex_version"])' "$man" 2>/dev/null || true)"
    expect_eq "t05n1 capture manifest codex_version is null (no controller PATH seeding)" "None" "$mver"
    led="$REPO_ROOT/.artifacts/agent-runs/$latest/run-ledger.json"
    [ -f "$led" ] && ok "t05n2 run-ledger.json auto-generated at stop" || bad "t05n2 run-ledger.json auto-generated at stop"
    "$PY" -c 'import json,sys
d = json.load(open(sys.argv[1]))
assert d["schema_version"] == 4 and d["run_id"] == sys.argv[2]
assert "context" in d and "comparability" in d and "diagnostics" in d' "$led" "$latest" \
      && ok "t05n3 auto ledger is a valid v4 record for the run" || bad "t05n3 auto ledger is a valid v4 record for the run"
    doc="$(cd "$REPO_ROOT/.artifacts/agent-runs" && readlink latest)/agent-doctor-start.json"
    [ -f "$REPO_ROOT/.artifacts/agent-runs/$doc" ] && ok "t05n4 doctor snapshot stored in the run dir at start" || bad "t05n4 doctor snapshot stored in the run dir at start"
    "$PY" -c 'import json,sys
d = json.load(open(sys.argv[1]))
assert d["tool"] == "agent-doctor"
assert isinstance(d["summary"]["overall"], str)' "$REPO_ROOT/.artifacts/agent-runs/$doc" \
      && ok "t05n5 doctor snapshot is the real agent-doctor JSON (status recorded, never aborts)" || bad "t05n5 doctor snapshot is the real agent-doctor JSON (status recorded, never aborts)"
    rawdir="$REPO_ROOT/.artifacts/agent-runs/$latest/raw"
    expect_contains "t05o fake email dropped from persisted trace" "no" "$([ -d "$rawdir" ] && { grep -rl "test-secret-email@example.com" "$rawdir" 2>/dev/null | head -n1 || echo no; })"
    expect_not_contains "t05p fake sk- token absent from persisted trace" "$([ -d "$rawdir" ] && grep -rh "sk-fake-test-1a2b3c4d5e6f" "$rawdir" 2>/dev/null || true)" "sk-fake-test-1a2b3c4d5e6f"
    expect_not_contains "t05q fake xoxb token redacted from persisted trace" "$([ -d "$rawdir" ] && grep -rh "xoxb-fake-test-token-123456" "$rawdir" 2>/dev/null || true)" "xoxb-fake-test-token-123456"
    E2E_DONE=1
  fi
else
  skip "t05collector not installed — collector-dependent e2e SKIPPED (./scripts/agent-observability install)"
  run_cmd bash "$OBS" doctor --json
  dout="$CAP_OUT"
  expect_rc "t05r doctor --json exits 0 without collector" 0 "$RC"
  dstat="$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["status"])' "$dout" 2>/dev/null || true)"
  expect_eq "t05s doctor reports NOT_CONFIGURED without collector" "NOT_CONFIGURED" "$dstat"
  run_cmd bash "$OBS" start
  expect_rc "t05t start without collector exits 3" 3 "$RC"
fi

# ------------------------------------------------------------- t06 template --
expect_contains "t06a template binds loopback only" "$([ -f "$TEMPLATE" ] && cat "$TEMPLATE" || true)" "127.0.0.1:__PORT__"
expect_not_contains "t06b template never binds 0.0.0.0" "$([ -f "$TEMPLATE" ] && cat "$TEMPLATE" || true)" "0.0.0.0"
tpl="$([ -f "$TEMPLATE" ] && cat "$TEMPLATE" || true)"
declare -a SANITIZE_KEYS=(
  "user.email|delete_key(log.attributes, \"user.email\")"
  "user.account_id|delete_key(log.attributes, \"user.account_id\")"
  "auth.env_provider_key_name|delete_key(log.attributes, \"auth.env_provider_key_name\")"
  "error.message|delete_key(log.attributes, \"error.message\")"
  "endpoint|delete_key(log.attributes, \"endpoint\")"
  "prompt|delete_key(log.attributes, \"prompt\")"
  "arguments|delete_key(log.attributes, \"arguments\")"
  "output|delete_key(log.attributes, \"output\")"
  # host.name is dropped via the resource whitelist (OTTL resource context
  # has no delete function in otelcol-contrib 0.161; keep_keys() is the
  # deterministic mechanism):
  "host.name|keep_keys(resource.attributes, [\"service.name\", \"service.version\", \"env\"])"
)
for pair in "${SANITIZE_KEYS[@]}"; do
  key="${pair%%|*}"
  stmt="${pair#*|}"
  expect_contains "t06c template drops sensitive key $key" "$tpl" "$stmt"
done

# ---------------------------------------------------------------- t07 pins ---
run_cmd "$PY" - "$PINS" <<'PYCHK'
import json, re, sys
pins = json.load(open(sys.argv[1]))
c = pins["collector"]
assert re.fullmatch(r"\d+\.\d+\.\d+", c["version"])
assert set(c["assets"]) == {"darwin_arm64", "darwin_amd64", "linux_amd64"}
for platform, a in c["assets"].items():
    assert re.fullmatch(r"[0-9a-f]{64}", a["sha256"]), platform
    assert a["file"].startswith("otelcol-contrib_"), platform
PYCHK
expect_rc "t07a pins.json schema + checksums valid" 0 "$RC"

# --------------------------------------------------------- t08 manifest.py ---
MTMP="$(mktemp -d "${TMPDIR:-/tmp}/fg-obs-manifest.XXXXXX")"
MENV="FG_OBS_REPO_ROOT=$REPO_ROOT FG_OBS_CODEX_VERSION=0.148.0 FG_OBS_CODEX_ACP_VERSION=1.7.0 FG_OBS_COLLECTOR_VERSION=0.161.0 FG_OBS_OTEL_ENDPOINT=http://127.0.0.1:4318 FG_OBS_PRIVACY_MODE=trace-safe-sanitized"
run_cmd env $MENV "$PY" "$MANIFEST_PY" seed "$MTMP/run-a" "run-a" "capture"
expect_rc "t08a manifest seed exits 0" 0 "$RC"
cat > "$MTMP/run-a/raw/logs.jsonl" <<'JSONL'
{"resourceLogs":[{"resource":{"attributes":[{"key":"app.version","value":{"stringValue":"codex-0.148.0"}}]},"scopeLogs":[{"logRecords":[{"severityNumber":9,"attributes":[{"key":"event.name","value":{"stringValue":"codex.conversation_starts"}},{"key":"conversation.id","value":{"stringValue":"conv-test-123"}},{"key":"model","value":{"stringValue":"test-model"}}]}]}]}]}
{"resourceLogs":[{"resource":{"attributes":[]},"scopeLogs":[{"logRecords":[{"severityNumber":9,"attributes":[{"key":"event.name","value":{"stringValue":"codex.tool_result"}},{"key":"conversation.id","value":{"stringValue":"conv-test-123"}},{"key":"tool_name","value":{"stringValue":"shell"}}]}]}]}]}
JSONL
printf 'this line is corrupt json\n' >> "$MTMP/run-a/raw/logs.jsonl"
run_cmd env $MENV "$PY" "$MANIFEST_PY" finalize "$MTMP/run-a" --stop-status graceful
expect_rc "t08b manifest finalize (with corrupt trailing line) exits 0" 0 "$RC"
mout="$("$PY" "$MANIFEST_PY" summary "$MTMP/run-a")"
expect_contains "t08c manifest captured conversation id" "$mout" "conv-test-123"
expect_contains "t08d manifest counted conversation_starts" "$mout" "\"codex.conversation_starts\": 1"
expect_contains "t08e manifest counted tool_result" "$mout" "\"codex.tool_result\": 1"
expect_contains "t08f manifest stop_status graceful" "$mout" "\"stop_status\": \"graceful\""
expect_contains "t08g manifest lists raw files" "$mout" "logs.jsonl"
expect_contains "t08h manifest recorded model" "$mout" "test-model"
run_cmd env $MENV "$PY" "$MANIFEST_PY" finalize "$MTMP/run-a" --stop-status graceful
expect_rc "t08i manifest finalize is idempotent" 0 "$RC"

# interrupted second run must not corrupt the first run's artifacts
cp "$MTMP/run-a/raw/logs.jsonl" "$MTMP/run-a-raw-before"
mkdir -p "$MTMP/run-b/raw"
run_cmd env $MENV "$PY" "$MANIFEST_PY" seed "$MTMP/run-b" "run-b" "capture"
printf '{"resourceSpans":[{"scopeSpans":[{"spans":[{"name":"x","attributes":[]}]}]}]}\n' > "$MTMP/run-b/raw/traces.jsonl"
printf '{"broken' >> "$MTMP/run-b/raw/traces.jsonl"
run_cmd env $MENV "$PY" "$MANIFEST_PY" finalize "$MTMP/run-b" --stop-status interrupted
expect_rc "t08j interrupted run finalizes" 0 "$RC"
expect_eq "t08k prior run raw file untouched" "$(cat "$MTMP/run-a-raw-before")" "$(cat "$MTMP/run-a/raw/logs.jsonl")"
bstat="$("$PY" "$MANIFEST_PY" summary "$MTMP/run-b" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["stop_status"])')"
expect_eq "t08l interrupted run recorded as interrupted" "interrupted" "$bstat"
# Captured conversation identity (relay path): persisted at seed time;
# manual starts leave it null; an invalid (non-identifier) value is
# refused fail-safe as null (never prompt-shaped text).
run_cmd env $MENV FG_OBS_CAPTURED_CONVERSATION_ID=conv-test-123 "$PY" "$MANIFEST_PY" seed "$MTMP/run-c" "run-c" "capture"
expect_rc "t08m manifest seed with captured conversation id exits 0" 0 "$RC"
mout2="$("$PY" "$MANIFEST_PY" summary "$MTMP/run-c")"
expect_contains "t08n manifest persists captured conversation id" "$mout2" '"captured_conversation_id": "conv-test-123"'
run_cmd env $MENV FG_OBS_CAPTURED_CONVERSATION_ID="" "$PY" "$MANIFEST_PY" seed "$MTMP/run-d" "run-d" "capture"
expect_rc "t08o manifest seed without identity exits 0" 0 "$RC"
mout3="$("$PY" "$MANIFEST_PY" summary "$MTMP/run-d")"
expect_contains "t08p manual start leaves captured conversation id null" "$mout3" '"captured_conversation_id": null'
run_cmd env $MENV FG_OBS_CAPTURED_CONVERSATION_ID="my prompt text" "$PY" "$MANIFEST_PY" seed "$MTMP/run-e" "run-e" "capture"
expect_rc "t08q manifest seed with invalid identity exits 0" 0 "$RC"
mout4="$("$PY" "$MANIFEST_PY" summary "$MTMP/run-e")"
expect_contains "t08r invalid identity refused fail-safe as null" "$mout4" '"captured_conversation_id": null'
run_cmd env $MENV FG_OBS_CAPTURED_CONVERSATION_ID=conv-test-123 "$PY" "$MANIFEST_PY" finalize "$MTMP/run-c" --stop-status graceful
expect_rc "t08s finalize keeps the seeded identity" 0 "$RC"
mout5="$("$PY" "$MANIFEST_PY" summary "$MTMP/run-c")"
expect_contains "t08t identity survives finalize" "$mout5" '"captured_conversation_id": "conv-test-123"'
rm -rf "$MTMP"

# --------------------------------------------------------- t09 probe client --
run_cmd node --check "$PROBE_CLIENT"
expect_rc "t09a probe client parses" 0 "$RC"
run_cmd node "$PROBE_CLIENT"
expect_rc "t09b probe client without args fails" 1 "$RC"
expect_contains "t09c probe client usage error names missing arg" "$CAP_OUT" "missing required arg"

# ---------------------------------------------------- t10 native-probe pre --
# Home/path resolution is driven by HOME plus explicit env vars on
# synthetic trees, so these tests are deterministic in any environment
# and never touch the real Codex home or auth file.
T10="$(mktemp -d "${TMPDIR:-/tmp}/fg-obs-t10.XXXXXX")"
mkdir -p "$T10/empty" "$T10/home/.codex" "$T10/amb/.codex" "$T10/amb/.codex-lucid"
printf 'model = "t"\n' > "$T10/home/.codex/config.toml"
printf '{}\n' > "$T10/home/.codex/auth.json"
printf 'model = "t"\n' > "$T10/amb/.codex/config.toml"
printf '{}\n' > "$T10/amb/.codex/auth.json"
printf 'model = "t"\n' > "$T10/amb/.codex-lucid/config.toml"
printf '{}\n' > "$T10/amb/.codex-lucid/auth.json"
# invalid candidate: config.toml without auth.json
mkdir -p "$T10/noauth/.codex"
printf 'model = "t"\n' > "$T10/noauth/.codex/config.toml"

# read the *generic/standalone* resolution surfaced by status (controller home)
t10json_state() { "$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["controller_codex_home"]["state"])' "$1" 2>/dev/null || true; }
t10json_path()  { "$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["controller_codex_home"]["path"])' "$1" 2>/dev/null || true; }

# missing: no candidates at all -> fail closed
run_cmd env -u CODEX_HOME -u CODEX_PATH HOME="$T10/empty" bash "$OBS" native-probe
expect_rc "t10a native-probe fails closed when no Codex home is discoverable (exit 5)" 5 "$RC"
expect_contains "t10b diagnostic advises exporting CODEX_HOME" "$CAP_OUT" "export CODEX_HOME"

# invalid candidate (config.toml without auth.json) -> rejected, fail closed
run_cmd env -u CODEX_HOME -u CODEX_PATH HOME="$T10/noauth" bash "$OBS" native-probe
expect_rc "t10c native-probe fails closed for a home missing auth.json (exit 5)" 5 "$RC"

# valid candidate, CODEX_HOME unset -> discovered (asserted via read-only
# status --json on the generic/standalone controller home)
run_cmd env -u CODEX_HOME -u CODEX_PATH -u CODEX_SESSION_ID FG_PRODUCT_RUNTIME_FILE="$TESTRT" HOME="$T10/home" bash "$OBS" status --json
t10out="$CAP_OUT"
expect_rc "t10d status with unset CODEX_HOME exits 0" 0 "$RC"
expect_eq "t10e unset CODEX_HOME discovers the normal Codex home" "discovered" "$(t10json_state "$t10out")"
expect_eq "t10f discovered path is the synthetic $HOME/.codex" "$T10/home/.codex" "$(t10json_path "$t10out")"

# ambiguous: two valid homes -> ambiguous + fail closed
run_cmd env -u CODEX_HOME -u CODEX_PATH -u CODEX_SESSION_ID FG_PRODUCT_RUNTIME_FILE="$TESTRT" HOME="$T10/amb" bash "$OBS" status --json
expect_eq "t10g multiple valid homes report ambiguous" "ambiguous" "$(t10json_state "$CAP_OUT")"
run_cmd env -u CODEX_HOME -u CODEX_PATH HOME="$T10/amb" bash "$OBS" native-probe
expect_rc "t10h native-probe fails closed on ambiguous homes (exit 5)" 5 "$RC"

# explicit CODEX_HOME stays authoritative for native-probe (wins over
# discovery): with an ambiguous HOME but an explicit VALID CODEX_HOME plus an
# invalid CODEX_PATH, native-probe must pass home resolution (accept the
# explicit home) and fail at PATH resolution -- never with a home-resolution
# (missing/ambiguous) diagnostic.
run_cmd env -u CODEX_PATH CODEX_HOME="$T10/home/.codex" CODEX_PATH="$T10/empty/missing" HOME="$T10/amb" bash "$OBS" native-probe
expect_rc "t10i native-probe accepts the explicit home (fails later at path, exit 5)" 5 "$RC"
expect_not_contains "t10j explicit CODEX_HOME not reported as ambiguous" "$CAP_OUT" "multiple valid Codex homes"
expect_not_contains "t10j2 explicit CODEX_HOME not reported as missing" "$CAP_OUT" "no valid Codex home"
expect_contains "t10j3 the failure is about CODEX_PATH" "$CAP_OUT" "CODEX_PATH"

# explicit but invalid CODEX_HOME -> fail closed
run_cmd env -u CODEX_PATH CODEX_HOME="$T10/amb" HOME="$T10/empty" bash "$OBS" native-probe
expect_rc "t10k explicit invalid CODEX_HOME fails closed (exit 5)" 5 "$RC"
expect_contains "t10l invalid-home diagnostic names the requirement" "$CAP_OUT" "config.toml and auth.json"

# explicit but invalid CODEX_PATH -> fail closed (home is valid here)
run_cmd env -u CODEX_HOME CODEX_PATH="$T10/empty/missing" HOME="$T10/home" bash "$OBS" native-probe
expect_rc "t10m explicit invalid CODEX_PATH fails closed (exit 5)" 5 "$RC"
rm -rf "$T10"

# ------------------------------------------------- t11 probe client ACP ----
# Deterministic ACP contract test: the fake agent accepts only the exact
# codex-acp 1.7.0 session/prompt schema ({ sessionId, prompt: ContentBlock[] })
# and rejects any other shape with the real adapter's -32602 error form.
FAKE_ACP="$REPO_ROOT/scripts/tests/fixtures/fake-acp-adapter.mjs"
T11="$(mktemp -d "${TMPDIR:-/tmp}/fg-obs-t11.XXXXXX")"
mkdir -p "$T11/cwd"
T11PARAMS="$T11/params.jsonl"
run_cmd env FAKE_ACP_PARAMS_FILE="$T11PARAMS" node "$PROBE_CLIENT" \
  --adapter "$FAKE_ACP" --cwd "$T11/cwd" --prompt "fake contract prompt" \
  --timeout 15000 --log "$T11/probe.log"
expect_rc "t11a probe client completes a prompt turn against the 1.7.0 contract" 0 "$RC"
expect_contains "t11b summary reports ok" "$CAP_OUT" '"ok": true'
expect_contains "t11c session id correlated in summary" "$CAP_OUT" "fake-session-0001"
expect_contains "t11d prompt turn completed with end_turn" "$CAP_OUT" '"stopReason": "end_turn"'
run_cmd "$PY" - "$T11PARAMS" <<'PYCHK'
import json, sys
params = json.loads(open(sys.argv[1]).readline())
assert params["sessionId"] == "fake-session-0001"
assert isinstance(params["prompt"], list) and len(params["prompt"]) >= 1
assert all(b.get("type") == "text" and isinstance(b.get("text"), str) and b["text"] for b in params["prompt"])
assert "content" not in params
PYCHK
expect_rc "t11e emitted prompt request matches the exact codex-acp 1.7.0 schema" 0 "$RC"
legacy='{"jsonrpc":"2.0","id":99,"method":"session/prompt","params":{"sessionId":"fake-session-0001","content":[{"type":"text","text":"x"}]}}'
legacyres="$(printf '%s\n' "$legacy" | node "$FAKE_ACP" | head -n1)"
expect_contains "t11f legacy content-key prompt is rejected with -32602" "$legacyres" '"code":-32602'
run_cmd env FAKE_ACP_INVALID_RESPONSE=1 FAKE_ACP_PARAMS_FILE="$T11PARAMS" node "$PROBE_CLIENT" \
  --adapter "$FAKE_ACP" --cwd "$T11/cwd" --prompt "fake contract prompt" \
  --timeout 15000 --log "$T11/probe2.log"
expect_rc "t11g invalid ACP response fails the client (exit 1)" 1 "$RC"
expect_contains "t11h failure reports ok=false" "$CAP_OUT" '"ok": false'
expect_contains "t11i failure carries the JSON-RPC error" "$CAP_OUT" "Invalid params"
rm -rf "$T11"


# ------------------------------------------------------- t12 run ledger ----
# Fully synthetic capture: fixture sanitized OTel + real manifest
# seed/finalize in a temp git repo. No collector, no network, no product
# code; deterministic in any environment.
T12="$(mktemp -d "${TMPDIR:-/tmp}/fg-obs-ledger.XXXXXX")"
mkdir -p "$T12/repo"
( cd "$T12/repo" && git init -q . && git config user.email ledger@test && \
  git config user.name ledger && printf 'base\n' > a.txt && git add a.txt && \
  git commit -qm base )
# MENV2 carries the captured conversation identity (the relay path): the
# fixture's single conversation (conv-ledger-42) IS the captured one —
# Case A, the clean single-conversation run.
RUNA="$T12/runs/run-20260101T000000Z"
mkdir -p "$RUNA/raw"
MENV2="FG_OBS_REPO_ROOT=$T12/repo FG_OBS_CODEX_VERSION=0.139.0 FG_OBS_CODEX_ACP_VERSION=1.7.0 FG_OBS_COLLECTOR_VERSION=0.161.0 FG_OBS_OTEL_ENDPOINT=http://127.0.0.1:4318 FG_OBS_PRIVACY_MODE=trace-safe-sanitized FG_OBS_CAPTURED_CONVERSATION_ID=conv-ledger-42"
run_cmd env $MENV2 "$PY" "$MANIFEST_PY" seed "$RUNA" run-20260101T000000Z capture
expect_rc "t12a fixture run manifest seed exits 0" 0 "$RC"
printf 'more\n' >> "$T12/repo/a.txt"   # working tree becomes dirty after seed

# Fixture sanitized OTel (values already collector-sanitized; dropped keys
# like output/arguments carry fake secrets the ledger must never copy).
"$PY" - "$RUNA/raw/logs.jsonl" <<'FIXPY'
import json, sys
def rec(ts, name, **kw):
    attrs = {"event.timestamp": ts, "event.name": name,
             "conversation.id": "conv-ledger-42", "model": "ledger-model",
             "app.version": "0.148.0", "originator": "fixture-originator"}
    attrs.update(kw)
    return {"resourceLogs": [{"resource": {"attributes": []}, "scopeLogs": [
        {"logRecords": [{"severityNumber": 9,
                         "attributes": [{"key": k, "value": {"stringValue": str(v)}} for k, v in sorted(attrs.items())]}]}]}]}
lines = [
    rec("2026-01-01T00:00:00.000Z", "codex.conversation_starts", reasoning_effort="low",
        sandbox_policy="workspace-write", approval_policy="on-request"),
    rec("2026-01-01T00:00:01.000Z", "codex.user_prompt", prompt_length="64"),
    rec("2026-01-01T00:00:02.000Z", "codex.api_request", attempt="0",
        **{"http.response.status_code": "200", "success": "true", "duration_ms": "100"}),
    rec("2026-01-01T00:00:05.000Z", "codex.tool_result", tool_name="exec_command",
        call_id="c1", success="true", duration_ms="90",
        **{"output": "FAKE_LEDGER_SECRET output-leak-1a2b",
           "arguments": "FAKE_LEDGER_SECRET args-leak-3c4d"}),
    rec("2026-01-01T00:00:06.000Z", "codex.tool_result", tool_name="exec_command",
        call_id="c2", success="false", duration_ms="40"),
    rec("2026-01-01T00:00:07.000Z", "codex.tool_result", tool_name="apply_patch",
        call_id="c3", success="true", duration_ms="60"),
    rec("2026-01-01T00:00:08.000Z", "codex.api_request", attempt="1",
        **{"http.response.status_code": "500", "success": "false", "duration_ms": "220"}),
    rec("2026-01-01T00:00:10.000Z", "codex.sse_event",
        **{"event.kind": "response.completed", "input_token_count": "1000",
           "output_token_count": "50", "cached_token_count": "800",
           "cache_write_token_count": "0", "reasoning_token_count": "5"}),
]
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    for l in lines:
        fh.write(json.dumps(l, sort_keys=True) + "\n")
    fh.write('{"broken": truncat\n')  # interrupted-run safety: corrupt final line
FIXPY

run_cmd env $MENV2 "$PY" "$MANIFEST_PY" finalize "$RUNA" --stop-status graceful
expect_rc "t12b fixture run manifest finalize exits 0" 0 "$RC"
LEDGER_PY="$REPO_ROOT/scripts/observability/ledger.py"
sha256_file() { "$PY" -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1"; }
RAW_BEFORE="$(sha256_file "$RUNA/raw/logs.jsonl")"

LED="$RUNA/run-ledger.json"
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNA"
expect_rc "t12c ledger normalize exits 0" 0 "$RC"
expect_file "t12d ledger record written" "$LED"
run_cmd "$PY" - "$LED" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["schema_version"] == 4
assert d["record_name"] == "fg-agent-run-ledger"
assert d["run_id"] == "run-20260101T000000Z"
assert set(d) == {"schema_version", "record_name", "run_id", "identity",
                  "runtime", "context", "git_wip", "activity",
                  "verification", "failures", "human", "comparability",
                  "diagnostics", "evidence_gaps"}
i = d["identity"]
assert i["conversation_ids"] == ["conv-ledger-42"]
# Case A: the persisted captured identity names the single observed
# conversation; primary metrics are unchanged (clean run stays clean)
# and NO foreign-telemetry diagnostic is emitted.
assert i["captured_conversation_id"] == "conv-ledger-42"
f = d["activity"]["foreign"]
assert f["present"] is False and f["conversation_count"] == 0
assert f["conversation_ids"] == []
assert f["api_request_count"] == 0 and f["failed_api_requests"] == 0
assert f["tool_call_count"] == 0 and f["failed_tool_calls"] == 0
assert f["turn_count"] == 0 and f["token_usage_total"] is None
assert "captured_conversation_unknown" not in d["evidence_gaps"]
assert i["capture_kind"] == "capture"
assert isinstance(i["start_ts"], str) and isinstance(i["end_ts"], str)
assert i["duration_s"] is not None
assert i["stop_status"] == "graceful"
r = d["runtime"]
assert r["models"] == ["ledger-model"]
# product Codex version is attributed from the telemetry app.version the
# Codex process itself emitted (0.148.0), never from the seed-time /
# controller discovery (manifest codex_version="0.139.0")
assert r["codex_version"] == "0.148.0"
assert r["app_versions"] == ["0.148.0"]
assert "codex_version_unresolved" not in d["evidence_gaps"]
assert d["comparability"]["dimensions"]["codex_version"] is True
assert r["codex_acp_version"] == "1.7.0"  # independent of codex version
assert r["privacy_mode"] == "trace-safe-sanitized"
# native run-level config: only what the fixture event actually carries
assert r["reasoning_effort"] == "low"
assert r["sandbox_mode"] == "workspace-write"
assert r["approval_policy"] == "on-request"
# no run-context attached yet: bounded nulls, gap present
assert d["context"] == {"task_type": None, "session_mode": None,
                        "task_key": None, "harness_variant": None}
assert "no_run_context" in d["evidence_gaps"]
comp = d["comparability"]
assert comp["dimensions"]["model"] is True
assert comp["dimensions"]["reasoning_effort"] is True
assert comp["dimensions"]["sandbox_mode"] is True
assert comp["dimensions"]["approval_policy"] is True
assert comp["dimensions"]["task_type"] is False
assert comp["dimensions"]["session_mode"] is False
assert comp["missing"] == sorted(comp["missing"])
assert "task_type" in comp["missing"] and "session_mode" in comp["missing"]
PYCHK
expect_rc "t12e ledger v4 schema + identity/runtime/context/comparability valid" 0 "$RC"

# diagnostics (schema v4) on the normal fixture run: nothing detected and
# every signal EVALUATED (no unevaluated entries) — 3 tools / 1 failure,
# 50 output tokens and a seconds-long window are not pathological shapes.
run_cmd "$PY" - "$LED" <<'PYDIAGA0'
import json, sys
dg = json.load(open(sys.argv[1]))["diagnostics"]["pathological_run"]
assert dg["detected"] is False and dg["signals"] == []
assert dg["unevaluated"] == []
PYDIAGA0
expect_rc "t12e2 diagnostics: normal fixture run not flagged, all signals evaluated" 0 "$RC"

run_cmd cp "$LED" "$T12/ledger-first.json"
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNA"
expect_rc "t12f re-normalize exits 0 (idempotent)" 0 "$RC"
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNA"
run_cmd cmp -s "$LED" "$T12/ledger-first.json"
expect_rc "t12g re-normalization is byte-identical (idempotent)" 0 "$RC"

run_cmd "$PY" - "$LED" <<'PYCHK'
import json, sys
a = json.load(open(sys.argv[1]))["activity"]
assert a["tool_call_count"] == 3
assert a["tool_calls_by_type"] == {"file": 1, "shell": 2}
assert a["successful_tool_calls"] == 2
assert a["failed_tool_calls"] == 1
assert a["shell_command_count"] == 2
assert a["failed_shell_commands"] == 1
assert a["file_activity_count"] == 1
assert a["api_request_count"] == 2
assert a["failed_api_requests"] == 1
assert a["turn_count"] == 1
t = a["token_usage"]
assert t["source"] == "sse-events"
assert (t["input"], t["output"], t["cached"], t["cache_write"], t["reasoning"], t["total"]) == (1000, 50, 800, 0, 5, 1855)
assert a["time_to_first_tool_action_ms"] == 4000
assert a["time_to_first_failure_ms"] == 5000
assert a["time_to_final_response_ms"] == 9000
g = json.load(open(sys.argv[1]))["git_wip"]
assert g["starting_tree"] == "clean"
assert g["ending_tree"] == "dirty"
assert g["changed_file_count"] == 1
assert g["changed_files"] == ["a.txt"]
assert g["changed_files_truncated"] is False
assert g["lines_added"] == 1 and g["lines_deleted"] == 0
assert g["commit_created"] is False
assert g["starting_head"] == g["ending_head"]
PYCHK
expect_rc "t12h activity/timing/token/git metrics exact" 0 "$RC"

out="$(cat "$LED")"
expect_not_contains "t12i dropped-key fake output value never reaches ledger" "$out" "output-leak-1a2b"
expect_not_contains "t12j dropped-key fake arguments value never reaches ledger" "$out" "args-leak-3c4d"
expect_not_contains "t12k no raw event names in public schema" "$out" "codex.tool_result"

# failures: exact observable records, no invented classifications
run_cmd "$PY" - "$LED" <<'PYCHK'
import json, sys
fs = json.load(open(sys.argv[1]))["failures"]
assert len(fs) == 2, fs
assert fs[0]["kind"] == "tool_call" and fs[0]["identifier"] == "exec_command"
assert fs[0]["ref"] == "c2" and fs[0]["result"] == "success=false"
assert fs[0]["classification"] is None
assert fs[1]["kind"] == "api_request" and fs[1]["identifier"] == "model_api_request"
assert fs[1]["ref"] == "1" and fs[1]["result"] == "http_status=500"
assert fs[1]["classification"] is None
PYCHK
expect_rc "t12l failure records observable-only, classification null" 0 "$RC"

# explicit verification correlation (agentRunId) + doctor evidence
cat > "$RUNA/verify-quick.json" <<'VERIFYJSON'
{
  "schemaVersion": 1, "profile": "quick", "mode": "run",
  "agentRunId": "run-20260101T000000Z", "result": "fail", "exitCode": 7,
  "startedAt": "2026-01-01T01:00:00Z", "finishedAt": "2026-01-01T01:00:05Z",
  "durationMs": 5000,
  "phases": [
    {"name": "repo: hygiene", "command": "git diff HEAD --check", "outcome": "passed", "exitCode": 0, "durationMs": 100},
    {"name": "frontend: typecheck", "command": "npm run typecheck", "outcome": "failed", "exitCode": 7, "durationMs": 4900}
  ]
}
VERIFYJSON
cat > "$RUNA/agent-doctor.json" <<'DOCTORJSON'
{
  "schema_version": 1, "tool": "agent-doctor",
  "result": "OK",
  "capabilities": [
    {"name": "node", "status": "available"},
    {"name": "chromium_launch", "status": "blocked"}
  ]
}
DOCTORJSON
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNA"
expect_rc "t12m normalize with verification + doctor evidence exits 0" 0 "$RC"
run_cmd "$PY" - "$LED" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
v = d["verification"]
assert len(v["profiles"]) == 1
p = v["profiles"][0]
assert p["profile"] == "quick" and p["result"] == "fail" and p["exit_code"] == 7
assert p["agent_run_id"] == "run-20260101T000000Z"
assert p["source"] == "verify-quick.json"
assert [ph["outcome"] for ph in p["phases"]] == ["passed", "failed"]
assert v["final_gate"] == {"profile": "quick", "result": "fail", "source": "verify-quick.json"}
assert v["doctor"]["status"] == "OK"
assert v["doctor"]["capabilities"] == [
    {"name": "node", "status": "available"},
    {"name": "chromium_launch", "status": "blocked"}]
fs = d["failures"]
ph_fail = [f for f in fs if f["kind"] == "verification_phase"]
assert len(ph_fail) == 1
assert ph_fail[0]["identifier"] == "frontend: typecheck"
assert ph_fail[0]["result"] == "exit_code=7"
assert ph_fail[0]["classification"] is None
PYCHK
expect_rc "t12n verification + doctor evidence normalized" 0 "$RC"

# human annotation: post-hoc, raw telemetry untouched, classification explicit
run_cmd "$PY" "$LEDGER_PY" annotate "$RUNA" --correction yes --category wrong_scope \
  --note "agent edited the wrong module"
expect_rc "t12o annotate exits 0" 0 "$RC"
run_cmd "$PY" "$LEDGER_PY" annotate "$RUNA" --correction no --classification PRODUCT_REGRESSION --for-failure c2
expect_rc "t12p classification annotation exits 0" 0 "$RC"
RAW_AFTER="$(sha256_file "$RUNA/raw/logs.jsonl")"
expect_eq "t12q annotation left raw telemetry byte-identical" "$RAW_BEFORE" "$RAW_AFTER"
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNA"
expect_rc "t12r re-normalize after annotation exits 0" 0 "$RC"
run_cmd "$PY" - "$LED" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
h = d["human"]
assert h["correction_occurred"] == "yes"
assert h["categories"] == ["wrong_scope"]
assert len(h["annotations"]) == 2
assert h["annotations"][0]["category"] == "wrong_scope"
assert h["annotations"][0]["note"] == "agent edited the wrong module"
tool = [f for f in d["failures"] if f["ref"] == "c2"][0]
assert tool["classification"] == "PRODUCT_REGRESSION"
api = [f for f in d["failures"] if f["kind"] == "api_request"][0]
assert api["classification"] is None  # unclassified failures stay null
PYCHK
expect_rc "t12s annotation re-read; classification attached exactly once" 0 "$RC"

# invalid annotation inputs
run_cmd "$PY" "$LEDGER_PY" annotate "$RUNA" --correction maybe
expect_rc "t12t invalid --correction rejected (exit 2)" 2 "$RC"
run_cmd "$PY" "$LEDGER_PY" annotate "$RUNA" --correction yes
expect_rc "t12u correction without category rejected (exit 2)" 2 "$RC"
run_cmd "$PY" "$LEDGER_PY" annotate "$RUNA" --correction no --classification PRODUCT_REGRESSION
expect_rc "t12v classification without --for-failure rejected (exit 2)" 2 "$RC"
run_cmd "$PY" "$LEDGER_PY" annotate "$RUNA" --correction no --classification BOGUS_CLASS --for-failure c2
expect_rc "t12w unknown classification rejected (exit 2)" 2 "$RC"

# attribution mismatch fails clearly (separate fixture run)
RUNC="$T12/runs/probe-native-20260101T000001Z"
mkdir -p "$RUNC/raw"
cat > "$RUNC/capture-manifest.json" <<'MANJSON'
{
  "schema_version": 1, "run_id": "probe-native-20260101T000001Z",
  "kind": "probe-native", "start_ts": "2026-01-01T00:00:00Z",
  "end_ts": "2026-01-01T00:00:02Z", "stop_status": "graceful",
  "repo_root": null, "branch": null, "starting_head": null,
  "starting_tree": null,
  "codex_version": "codex-cli 0.139.0", "codex_acp_version": "1.7.0",
  "collector_version": "0.161.0", "otel_endpoint": "http://127.0.0.1:4318",
  "privacy_mode": "trace-safe-sanitized",
  "raw_trace_files": [], "conversation_ids": [], "event_counts": {},
  "app_versions": [], "models": [], "originators": [],
  "span_counts": {}, "metric_names": {},
  "log_record_count": 0, "span_count": 0, "metric_series_count": 0
}
MANJSON
cp "$RUNA/verify-quick.json" "$RUNC/verify-quick.json"
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNC"
expect_rc "t12x foreign agentRunId fails clearly (exit 8)" 8 "$RC"
expect_contains "t12y mismatch message names attribution" "$CAP_OUT" "attribution mismatch"

# missing required manifest fails clearly
RUNBAD="$T12/runs/run-20260101T000002Z"
mkdir -p "$RUNBAD/raw"
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNBAD"
expect_rc "t12z missing capture manifest fails clearly (exit 7)" 7 "$RC"
expect_contains "t12aa missing-manifest message names the file" "$CAP_OUT" "capture-manifest.json"

# missing optional telemetry -> null + gap codes, no failure
RUNE="$T12/runs/run-20260101T000003Z"
mkdir -p "$RUNE/raw"
cp "$RUNC/capture-manifest.json" "$RUNE/capture-manifest.json"
# rewrite run id to match this directory (manifest run_id must equal dir name)
"$PY" - "$RUNE/capture-manifest.json" run-20260101T000003Z <<'FIXPY3'
import json, sys
d = json.load(open(sys.argv[1]))
d["run_id"] = sys.argv[2]
json.dump(d, open(sys.argv[1], "w"), indent=2, sort_keys=True)
FIXPY3
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNE"
expect_rc "t12ab normalize without telemetry exits 0" 0 "$RC"
run_cmd "$PY" - "$RUNE/run-ledger.json" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
a = d["activity"]
assert a["tool_call_count"] is None
assert a["tool_calls_by_type"] == {}
assert a["turn_count"] is None
assert a["token_usage"]["source"] is None
assert a["time_to_first_tool_action_ms"] is None
assert d["failures"] == []
gaps = d["evidence_gaps"]
for code in ("no_telemetry", "no_metrics_file", "token_usage_unavailable",
             "no_end_git_evidence", "no_verification_evidence",
             "no_doctor_evidence", "no_annotations", "no_run_context"):
    assert code in gaps, gaps
assert d["human"]["correction_occurred"] is None
assert d["runtime"]["reasoning_effort"] is None  # absent, never guessed
assert d["runtime"]["sandbox_mode"] is None
assert d["runtime"]["approval_policy"] is None
assert d["comparability"]["dimensions"]["reasoning_effort"] is False
assert "reasoning_effort" in d["comparability"]["missing"]
# no product app.version in telemetry -> codex_version stays explicitly
# unresolved; the manifest's controller discovery (0.139.0) never leaks in
assert d["runtime"]["codex_version"] is None
assert d["runtime"]["app_versions"] == []
assert "codex_version_unresolved" in gaps
assert d["comparability"]["dimensions"]["codex_version"] is False
assert "codex_version" in d["comparability"]["missing"]
PYCHK
expect_rc "t12ac missing telemetry yields null + gap codes (no inference)" 0 "$RC"
# multiple distinct product app.version values in one run: all are
# preserved in app_versions, codex_version stays unresolved (never guessed),
# and controller discovery is still not substituted
RUNF="$T12/runs/run-20260101T000004Z"
mkdir -p "$RUNF/raw"
cp "$RUNE/capture-manifest.json" "$RUNF/capture-manifest.json"
"$PY" - "$RUNF/capture-manifest.json" run-20260101T000004Z <<'FIXPY4'
import json, sys
d = json.load(open(sys.argv[1]))
d["run_id"] = sys.argv[2]
d["app_versions"] = ["0.148.0", "0.149.0"]  # post-finalize scan state
json.dump(d, open(sys.argv[1], "w"), indent=2, sort_keys=True)
FIXPY4
"$PY" - "$RUNF/raw/logs.jsonl" <<'FIXLOG4'
import json, sys
def rec(ts, ver):
    attrs = {"event.timestamp": ts, "event.name": "codex.sse_event",
             "conversation.id": "conv-multi-1",
             "app.version": ver, "event.kind": "response.completed"}
    return {"resourceLogs": [{"resource": {"attributes": []}, "scopeLogs": [
        {"logRecords": [{"severityNumber": 9,
                         "attributes": [{"key": k, "value": {"stringValue": str(v)}} for k, v in sorted(attrs.items())]}]}]}]}
lines = [rec("2026-01-01T00:00:00.000Z", "0.148.0"),
         rec("2026-01-01T00:00:01.000Z", "0.149.0")]
with open(sys.argv[1], "w") as fh:
    for l in lines:
        fh.write(json.dumps(l, sort_keys=True) + "\n")
FIXLOG4
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNF"
expect_rc "t12ac2 normalize with multiple app versions exits 0" 0 "$RC"
run_cmd "$PY" - "$RUNF/run-ledger.json" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
r = d["runtime"]
assert r["app_versions"] == ["0.148.0", "0.149.0"]  # all values preserved
assert r["codex_version"] is None  # not guessed
assert r["codex_acp_version"] == "1.7.0"  # independent field
assert "codex_version_unresolved" in d["evidence_gaps"]
assert "no_telemetry" not in d["evidence_gaps"]
assert d["comparability"]["dimensions"]["codex_version"] is False
assert "codex_version" in d["comparability"]["missing"]
PYCHK
expect_rc "t12ac3 multiple app versions: preserved, unresolved, no guess" 0 "$RC"

# Dedup-identity regression (paired response.completed): records that share
# the correlation tuple (event name / timestamp / conversation.id /
# reference) but differ in their SANITIZED attributes are distinct logical
# events; byte-equivalent copies of one record still collapse to one.
# Fixture reconstructed from the paired 0.148.0 response.completed shape
# observed in stored product telemetry (run-20260921T111009Z): one record
# without token counters + one with counters at the same millisecond.
RUND="$T12/runs/run-20260101T000005Z"
mkdir -p "$RUND/raw"
cp "$RUNE/capture-manifest.json" "$RUND/capture-manifest.json"
"$PY" - "$RUND/capture-manifest.json" run-20260101T000005Z <<'FIXPY5'
import json, sys
d = json.load(open(sys.argv[1]))
d["run_id"] = sys.argv[2]
json.dump(d, open(sys.argv[1], "w"), indent=2, sort_keys=True)
FIXPY5
"$PY" - "$RUND/raw/logs.jsonl" <<'FIXLOG5'
import json, sys
def sse(ts, **kw):
    attrs = {"event.timestamp": ts, "event.name": "codex.sse_event",
             "conversation.id": "conv-dedup-1", "model": "dedup-model",
             "app.version": "0.148.0", "originator": "fixture-originator",
             "event.kind": "response.completed"}
    attrs.update(kw)
    return {"resourceLogs": [{"resource": {"attributes": []}, "scopeLogs": [
        {"logRecords": [{"severityNumber": 9,
                         "attributes": [{"key": k, "value": {"stringValue": str(v)}} for k, v in sorted(attrs.items())]}]}]}]}
# T0 pair: identical name/timestamp/conversation/reference, distinct
# sanitized attributes (A without counters, B with counters).
A = sse("2026-01-01T00:00:10.000Z", duration_ms="53")
B = sse("2026-01-01T00:00:10.000Z",
        input_token_count="108787", output_token_count="11957",
        cached_token_count="105600", cache_write_token_count="0",
        reasoning_token_count="11834", tool_token_count="120744",
        ttft_ms="950", model_reasoning_effort="medium")
# T1: counter-bearing record emitted twice, byte-equivalent (true duplicate).
C = sse("2026-01-01T00:00:12.000Z",
        input_token_count="100", output_token_count="20",
        cached_token_count="0", cache_write_token_count="0",
        reasoning_token_count="5")
def toolrec():
    attrs = {"event.timestamp": "2026-01-01T00:00:14.000Z",
             "event.name": "codex.tool_result",
             "conversation.id": "conv-dedup-1", "model": "dedup-model",
             "app.version": "0.148.0", "originator": "fixture-originator",
             "tool_name": "exec_command", "call_id": "d1",
             "success": "true", "duration_ms": "90"}
    return {"resourceLogs": [{"resource": {"attributes": []}, "scopeLogs": [
        {"logRecords": [{"severityNumber": 9,
                         "attributes": [{"key": k, "value": {"stringValue": str(v)}} for k, v in sorted(attrs.items())]}]}]}]}
D = toolrec()
with open(sys.argv[1], "w") as fh:
    for l in (A, B, C, C, D, D):
        fh.write(json.dumps(l, sort_keys=True) + "\n")
FIXLOG5
run_cmd "$PY" "$LEDGER_PY" normalize "$RUND"
expect_rc "t12dedup0 dedup fixture normalize exits 0" 0 "$RC"
# Case A (distinct pair survives) + Case B (exact copies collapse), at the
# logical-event level.
run_cmd "$PY" - "$LEDGER_PY" "$RUND" <<'PYDEDUP'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("ledger", sys.argv[1])
ledger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ledger)
evs = ledger.collect_events(sys.argv[2])
sse = [e for e in evs if e["name"] == "codex.sse_event"
       and e["attrs"].get("event.kind") == "response.completed"]
# Case A: the T0 pair (same name/timestamp/conversation/reference, distinct
# sanitized attributes) survives as two logical events.
t0 = [e for e in sse if e["ts_iso"] == "2026-01-01T00:00:10.000Z"]
assert len(t0) == 2, t0
assert sum(1 for e in t0 if e["attrs"].get("input_token_count") is None) == 1
assert sum(1 for e in t0 if e["attrs"].get("input_token_count") is not None) == 1
# Case B: the byte-equivalent copies collapse to one logical event each.
assert len(sse) == 3, len(sse)
tools = [e for e in evs if e["name"] == "codex.tool_result"]
assert len(tools) == 1, len(tools)
assert len(evs) == 4, len(evs)
PYDEDUP
expect_rc "t12dedup1 distinct paired records kept, exact copies collapsed" 0 "$RC"
# Case A at the ledger level: the counter-bearing record of the T0 pair
# contributes to token accounting (input 108787+100, output 11957+20,
# cached 105600+0, cache_write 0, reasoning 11834+5).
run_cmd "$PY" - "$RUND/run-ledger.json" <<'PYDEDUP2'
import json, sys
a = json.load(open(sys.argv[1]))["activity"]
t = a["token_usage"]
assert t["source"] == "sse-events"
assert (t["input"], t["output"], t["cached"], t["cache_write"],
        t["reasoning"], t["total"]) == (108887, 11977, 105600, 0, 11839, 238303)
assert a["tool_call_count"] == 1  # the duplicated tool result is one call
PYDEDUP2
expect_rc "t12dedup2 counter-bearing pair contributes to token accounting" 0 "$RC"
# Privacy: the identity-only sanitized attributes that distinguish the pair
# (non-contract keys) are never copied into the ledger record.
out="$(cat "$RUND/run-ledger.json")"
expect_not_contains "t12dedup3 identity-only attribute name never reaches ledger" "$out" "tool_token_count"
expect_not_contains "t12dedup4 identity-only attribute value never reaches ledger" "$out" "120744"
# Case C: deterministic ledger generation (byte-identical re-normalization).
run_cmd cp "$RUND/run-ledger.json" "$T12/dedup-first.json"
run_cmd "$PY" "$LEDGER_PY" normalize "$RUND"
expect_rc "t12dedup5 dedup fixture re-normalize exits 0" 0 "$RC"
run_cmd cmp -s "$RUND/run-ledger.json" "$T12/dedup-first.json"
expect_rc "t12dedup6 dedup fixture ledger byte-identical across generations" 0 "$RC"

# ------------------------------------- captured conversation identity (v3) -
# The persisted captured conversation identity (manifest
# captured_conversation_id, relay path) scopes the primary activity /
# failure / token metrics to the captured conversation; foreign telemetry
# in the same raw run is reported explicitly via activity.foreign (never
# merged); a missing identity preserves the run-wide aggregate plus the
# explicit captured_conversation_unknown gap (never a heuristic pick).

# Case B — captured conversation A + foreign conversation B
RUNXB="$T12/runs/run-20260101T000010Z"
mkdir -p "$RUNXB/raw"
run_cmd env $MENV2 FG_OBS_CAPTURED_CONVERSATION_ID=conv-a "$PY" "$MANIFEST_PY" seed "$RUNXB" run-20260101T000010Z capture
expect_rc "t12capB0 captured+foreign fixture seed exits 0" 0 "$RC"
"$PY" - "$RUNXB/raw/logs.jsonl" <<'FIXLOGB'
import json, sys
def rec(ts, conv, name, **kw):
    attrs = {"event.timestamp": ts, "event.name": name,
             "conversation.id": conv, "app.version": "0.148.0"}
    attrs.update(kw)
    return {"resourceLogs": [{"resource": {"attributes": []}, "scopeLogs": [
        {"logRecords": [{"severityNumber": 9,
                         "attributes": [{"key": k, "value": {"stringValue": str(v)}} for k, v in sorted(attrs.items())]}]}]}]}
# captured conversation A: 1 API request, 0 tools, known token counters
lines = [
    rec("2026-01-01T00:00:00.000Z", "conv-a", "codex.conversation_starts"),
    rec("2026-01-01T00:00:01.000Z", "conv-a", "codex.user_prompt", prompt_length="10"),
    rec("2026-01-01T00:00:02.000Z", "conv-a", "codex.api_request", attempt="0",
        **{"http.response.status_code": "200", "duration_ms": "100"}),
    rec("2026-01-01T00:00:05.000Z", "conv-a", "codex.sse_event",
        **{"event.kind": "response.completed", "input_token_count": "100",
           "output_token_count": "20", "cached_token_count": "30",
           "cache_write_token_count": "0", "reasoning_token_count": "5"}),
    # foreign conversation B: multiple API requests (one failed),
    # multiple tools (one failed), failures, large token counters
    rec("2026-01-01T00:00:01.000Z", "conv-b", "codex.user_prompt", prompt_length="99"),
    rec("2026-01-01T00:00:02.000Z", "conv-b", "codex.api_request", attempt="0",
        **{"http.response.status_code": "200", "duration_ms": "120"}),
    rec("2026-01-01T00:00:03.000Z", "conv-b", "codex.api_request", attempt="1",
        **{"http.response.status_code": "500", "duration_ms": "80"}),
    rec("2026-01-01T00:00:04.000Z", "conv-b", "codex.api_request", attempt="2",
        **{"http.response.status_code": "200", "duration_ms": "110"}),
    rec("2026-01-01T00:00:06.000Z", "conv-b", "codex.tool_result",
        tool_name="exec_command", call_id="b1", success="false", duration_ms="40"),
    rec("2026-01-01T00:00:07.000Z", "conv-b", "codex.tool_result",
        tool_name="apply_patch", call_id="b2", success="true", duration_ms="60"),
    rec("2026-01-01T00:00:08.000Z", "conv-b", "codex.sse_event",
        **{"event.kind": "response.completed", "input_token_count": "1000",
           "output_token_count": "500", "cached_token_count": "100",
           "cache_write_token_count": "10", "reasoning_token_count": "50"}),
]
with open(sys.argv[1], "w") as fh:
    for l in lines:
        fh.write(json.dumps(l, sort_keys=True) + "\n")
FIXLOGB
run_cmd env $MENV2 FG_OBS_CAPTURED_CONVERSATION_ID=conv-a "$PY" "$MANIFEST_PY" finalize "$RUNXB" --stop-status graceful
expect_rc "t12capB1 fixture finalize exits 0" 0 "$RC"
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNXB"
expect_rc "t12capB2 normalize exits 0" 0 "$RC"
run_cmd "$PY" - "$RUNXB/run-ledger.json" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
i = d["identity"]
a = d["activity"]
# primary metrics: ONLY the captured conversation A
assert i["captured_conversation_id"] == "conv-a"
assert i["conversation_ids"] == ["conv-a", "conv-b"]
assert a["api_request_count"] == 1 and a["failed_api_requests"] == 0
assert a["tool_call_count"] == 0 and a["successful_tool_calls"] == 0
assert a["failed_tool_calls"] == 0 and a["shell_command_count"] == 0
assert a["file_activity_count"] == 0 and a["tool_calls_by_type"] == {}
assert a["turn_count"] == 1
t = a["token_usage"]
assert t["source"] == "sse-events"
assert (t["input"], t["output"], t["cached"], t["cache_write"],
        t["reasoning"], t["total"]) == (100, 20, 30, 0, 5, 155)
# B's failures must NOT reach the captured turn's failure records
assert d["failures"] == [], d["failures"]
# foreign telemetry from B is reported explicitly, never merged
f = a["foreign"]
assert f["present"] is True and f["conversation_count"] == 1
assert f["conversation_ids"] == ["conv-b"]
assert f["api_request_count"] == 3 and f["failed_api_requests"] == 1
assert f["tool_call_count"] == 2 and f["failed_tool_calls"] == 1
assert f["turn_count"] == 1 and f["token_usage_total"] == 1660
assert "captured_conversation_unknown" not in d["evidence_gaps"]
PYCHK
expect_rc "t12capB3 primary scoped to A, foreign B reported explicitly" 0 "$RC"

# diagnostics: the captured turn (A) is small and healthy; foreign B's
# values (1660 tokens, a failure) must NOT change the captured turn's
# diagnosis. All signals evaluated on A's scoped metrics; none fire.
run_cmd "$PY" - "$RUNXB/run-ledger.json" <<'PYDIAGB'
import json, sys
dg = json.load(open(sys.argv[1]))["diagnostics"]["pathological_run"]
assert dg["detected"] is False and dg["signals"] == []
assert dg["unevaluated"] == []
PYDIAGB
expect_rc "t12capB4 diagnostics never influenced by foreign telemetry" 0 "$RC"

# Case C — captured A + foreign B AND C (deterministic ordering) +
# metrics-sourced tokens with per-conversation datapoint attribution
# (a datapoint without a conversation.id is attributed to NOBODY)
RUNXC="$T12/runs/run-20260101T000011Z"
mkdir -p "$RUNXC/raw"
cat > "$RUNXC/capture-manifest.json" <<'MANJSON'
{
  "schema_version": 1, "run_id": "run-20260101T000011Z",
  "kind": "capture", "captured_conversation_id": "conv-a",
  "start_ts": "2026-01-01T00:00:00Z", "end_ts": "2026-01-01T00:01:00Z",
  "stop_status": "graceful",
  "repo_root": null, "branch": null, "starting_head": null,
  "starting_tree": null,
  "codex_version": null, "codex_acp_version": "1.7.0",
  "collector_version": "0.161.0", "otel_endpoint": "http://127.0.0.1:4318",
  "privacy_mode": "trace-safe-sanitized",
  "raw_trace_files": [], "conversation_ids": ["conv-a", "conv-b", "conv-c"],
  "event_counts": {}, "app_versions": ["0.148.0"], "models": [],
  "originators": [], "span_counts": {}, "metric_names": {},
  "log_record_count": 0, "span_count": 0, "metric_series_count": 3
}
MANJSON
"$PY" - "$RUNXC/raw/logs.jsonl" <<'FIXLOGC'
import json, sys
def rec(ts, conv, name, **kw):
    attrs = {"event.timestamp": ts, "event.name": name,
             "conversation.id": conv, "app.version": "0.148.0"}
    attrs.update(kw)
    return {"resourceLogs": [{"resource": {"attributes": []}, "scopeLogs": [
        {"logRecords": [{"severityNumber": 9,
                         "attributes": [{"key": k, "value": {"stringValue": str(v)}} for k, v in sorted(attrs.items())]}]}]}]}
lines = [
    rec("2026-01-01T00:00:02.000Z", "conv-a", "codex.api_request", attempt="0",
        **{"http.response.status_code": "200"}),
    rec("2026-01-01T00:00:03.000Z", "conv-b", "codex.api_request", attempt="0",
        **{"http.response.status_code": "200"}),
    rec("2026-01-01T00:00:04.000Z", "conv-b", "codex.tool_result",
        tool_name="grep", call_id="b1", success="true", duration_ms="10"),
    rec("2026-01-01T00:00:05.000Z", "conv-c", "codex.api_request", attempt="0",
        **{"http.response.status_code": "404"}),
]
with open(sys.argv[1], "w") as fh:
    for l in lines:
        fh.write(json.dumps(l, sort_keys=True) + "\n")
FIXLOGC
# metrics datapoints tagged by conversation.id; the third one carries NO
# conversation.id and must be attributed to nobody.
"$PY" - "$RUNXC/raw/metrics.jsonl" <<'METRICS'
import json, sys
def dp(val, conv=None):
    attrs = []
    if conv is not None:
        attrs = [{"key": "conversation.id", "value": {"stringValue": conv}}]
    return {"asInt": val, "attributes": attrs}
with open(sys.argv[1], "w") as fh:
    for val, conv in ((111, "conv-a"), (999, "conv-b"), (555, None)):
        payload = {"resourceMetrics": [{"scopeMetrics": [
            {"metrics": [{"name": "codex.turn.token_usage",
                          "sum": {"dataPoints": [dp(val, conv)]}}]}]}]}
        fh.write(json.dumps(payload, sort_keys=True) + "\n")
METRICS
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNXC"
expect_rc "t12capC0 normalize exits 0" 0 "$RC"
run_cmd "$PY" - "$RUNXC/run-ledger.json" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
i = d["identity"]
a = d["activity"]
f = a["foreign"]
assert i["captured_conversation_id"] == "conv-a"
# primary: A only — 1 API request, 0 tools, metrics-sourced tokens from
# A's datapoint ONLY (111; the 555 datapoint without a conversation id
# and the foreign 999 are not attributed to the captured turn)
assert a["api_request_count"] == 1 and a["failed_api_requests"] == 0
assert a["tool_call_count"] == 0 and a["failed_tool_calls"] == 0
t = a["token_usage"]
assert t["source"] == "metrics" and t["total"] == 111
# foreign: two conversations, deterministic (sorted) identities
assert f["present"] is True and f["conversation_count"] == 2
assert f["conversation_ids"] == ["conv-b", "conv-c"]
assert f["api_request_count"] == 2 and f["failed_api_requests"] == 1
assert f["tool_call_count"] == 1 and f["failed_tool_calls"] == 0
assert f["token_usage_total"] == 999
assert "captured_conversation_unknown" not in d["evidence_gaps"]
PYCHK
expect_rc "t12capC1 two foreign conversations, deterministic, no cross-attribution" 0 "$RC"

# diagnostics with metrics-sourced tokens: per-field token values are
# null (only total is attributable), so the generation-based signals are
# explicitly UNEVALUATED (missing_evidence) — never guessed, never
# silently false. The tool-based signal evaluates normally (0 tools ->
# false); the run-level signal has no Git evidence -> unevaluated too.
run_cmd "$PY" - "$RUNXC/run-ledger.json" <<'PYDIAGC'
import json, sys
dg = json.load(open(sys.argv[1]))["diagnostics"]["pathological_run"]
assert dg["detected"] is False and dg["signals"] == []
assert dg["unevaluated"] == [
    {"name": "extreme_reasoning_dominance", "reason": "missing_evidence"},
    {"name": "huge_generation_on_few_api_requests", "reason": "missing_evidence"},
    {"name": "long_generation_without_tool_progress", "reason": "missing_evidence"},
    {"name": "no_progress_after_long_run", "reason": "missing_evidence"},
]
PYDIAGC
expect_rc "t12capC2 metrics-sourced tokens: generation signals unevaluated, not guessed" 0 "$RC"

# Case D — mixed telemetry, NO persisted captured identity: the run-wide
# aggregate is preserved (backward compatible), NO conversation is
# heuristically selected, and the explicit gap is present
RUNXD="$T12/runs/run-20260101T000012Z"
mkdir -p "$RUNXD/raw"
cat > "$RUNXD/capture-manifest.json" <<'MANJSON'
{
  "schema_version": 1, "run_id": "run-20260101T000012Z",
  "kind": "capture", "captured_conversation_id": null,
  "start_ts": "2026-01-01T00:00:00Z", "end_ts": "2026-01-01T00:01:00Z",
  "stop_status": "graceful",
  "repo_root": null, "branch": null, "starting_head": null,
  "starting_tree": null,
  "codex_version": null, "codex_acp_version": "1.7.0",
  "collector_version": "0.161.0", "otel_endpoint": "http://127.0.0.1:4318",
  "privacy_mode": "trace-safe-sanitized",
  "raw_trace_files": [], "conversation_ids": ["conv-a", "conv-b"],
  "event_counts": {}, "app_versions": ["0.148.0"], "models": [],
  "originators": [], "span_counts": {}, "metric_names": {},
  "log_record_count": 0, "span_count": 0, "metric_series_count": 0
}
MANJSON
cp "$RUNXB/raw/logs.jsonl" "$RUNXD/raw/logs.jsonl"
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNXD"
expect_rc "t12capD0 normalize exits 0" 0 "$RC"
run_cmd "$PY" - "$RUNXD/run-ledger.json" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
i = d["identity"]
a = d["activity"]
assert i["captured_conversation_id"] is None
# backward-compatible aggregate (both conversations), no heuristic pick
assert a["api_request_count"] == 4 and a["failed_api_requests"] == 1
assert a["tool_call_count"] == 2 and a["failed_tool_calls"] == 1
assert a["turn_count"] == 2
t = a["token_usage"]
assert t["source"] == "sse-events" and t["total"] == 1815
# 'foreign' is undefined without a captured reference — the explicit gap
# carries the attribution statement instead
assert a["foreign"] is None
assert "captured_conversation_unknown" in d["evidence_gaps"]
PYCHK
expect_rc "t12capD1 missing identity: aggregate kept + explicit gap, no guessing" 0 "$RC"

# diagnostics without a persisted captured identity and with two observed
# conversations: the run-wide aggregate MUST NOT be read as the captured
# turn's activity, so every conversation-attributable signal is
# unevaluated (captured_conversation_unknown), never inferred. The
# run-level signal has no Git evidence -> unevaluated (missing_evidence).
# Nothing is detected and nothing is guessed.
run_cmd "$PY" - "$RUNXD/run-ledger.json" <<'PYDIAGD'
import json, sys
dg = json.load(open(sys.argv[1]))["diagnostics"]["pathological_run"]
assert dg["detected"] is False and dg["signals"] == []
assert dg["unevaluated"] == [
    {"name": "extreme_reasoning_dominance", "reason": "captured_conversation_unknown"},
    {"name": "high_failed_tool_concentration", "reason": "captured_conversation_unknown"},
    {"name": "huge_generation_on_few_api_requests", "reason": "captured_conversation_unknown"},
    {"name": "long_generation_without_tool_progress", "reason": "captured_conversation_unknown"},
    {"name": "no_progress_after_long_run", "reason": "missing_evidence"},
]
PYDIAGD
expect_rc "t12capD2 no identity + 2 conversations: attributable signals unevaluated" 0 "$RC"

# Case F — historical incident reconstruction (run-20260921T111009Z):
# the captured ACP session 01a0c3a6-dd79-7652-bb05-ecb528dd8c5d
# (prompt request id 14) emitted one model/API stream (the paired
# response.completed — one record without token counters, one with —
# and zero tools; its codex.api_request/user_prompt events rotated out
# of the raw capture before finalize). Foreign conversation
# 01a0c317-53f2-75c3-94cd-5c55f1905890 (a different, simultaneously
# active Codex session) landed 67 API requests, 72 tool results and
# 19M tokens into the same raw run. The real stored run cannot be
# retrofitted with the new persistent field without inference (its relay
# event log is a rotating shared diagnostic, not per-run durable
# metadata); this fixture mirrors its surviving evidence shape with the
# authoritative relay-log attribution applied to the fixture manifest.
# The fixture window mirrors the real run's 2178 s capture session
# (2026-09-21T11:10:09Z -> 2026-09-21T11:46:27Z) so the incident's
# duration is part of the replayed evidence.
RUNXF="$T12/runs/run-20260101T000013Z"
mkdir -p "$RUNXF/raw"
cat > "$RUNXF/capture-manifest.json" <<'MANJSON'
{
  "schema_version": 1, "run_id": "run-20260101T000013Z",
  "kind": "capture",
  "captured_conversation_id": "01a0c3a6-dd79-7652-bb05-ecb528dd8c5d",
  "start_ts": "2026-01-01T00:00:00Z", "end_ts": "2026-01-01T00:36:18Z",
  "stop_status": "graceful",
  "repo_root": null, "branch": null, "starting_head": null,
  "starting_tree": null,
  "codex_version": null, "codex_acp_version": "1.7.0",
  "collector_version": "0.161.0", "otel_endpoint": "http://127.0.0.1:4318",
  "privacy_mode": "trace-safe-sanitized",
  "raw_trace_files": [],
  "conversation_ids": ["01a0c317-53f2-75c3-94cd-5c55f1905890",
                        "01a0c3a6-dd79-7652-bb05-ecb528dd8c5d"],
  "event_counts": {}, "app_versions": ["0.148.0"], "models": [],
  "originators": [], "span_counts": {}, "metric_names": {},
  "log_record_count": 0, "span_count": 0, "metric_series_count": 0
}
MANJSON
"$PY" - "$RUNXF/raw/logs.jsonl" <<'FIXLOGF'
import json, sys
def rec(ts, conv, name, **kw):
    attrs = {"event.timestamp": ts, "event.name": name,
             "conversation.id": conv, "app.version": "0.148.0"}
    attrs.update(kw)
    return {"resourceLogs": [{"resource": {"attributes": []}, "scopeLogs": [
        {"logRecords": [{"severityNumber": 9,
                         "attributes": [{"key": k, "value": {"stringValue": str(v)}} for k, v in sorted(attrs.items())]}]}]}]}
CAP = "01a0c3a6-dd79-7652-bb05-ecb528dd8c5d"   # captured ACP session
FORE = "01a0c317-53f2-75c3-94cd-5c55f1905890"  # foreign session
lines = [
    # captured conversation: the surviving pair of response.completed for
    # its single model stream (no counters / with counters, same ms)
    rec("2026-01-01T00:00:05.000Z", CAP, "codex.sse_event",
        **{"event.kind": "response.completed", "duration_ms": "1611"}),
    rec("2026-01-01T00:00:05.001Z", CAP, "codex.sse_event",
        **{"event.kind": "response.completed", "input_token_count": "41016",
           "output_token_count": "221128", "cached_token_count": "36800",
           "cache_write_token_count": "0", "reasoning_token_count": "221128"}),
    # foreign conversation: active agent work in the same window
    rec("2026-01-01T00:00:01.000Z", FORE, "codex.user_prompt", prompt_length="64"),
    rec("2026-01-01T00:00:02.000Z", FORE, "codex.api_request", attempt="0",
        **{"http.response.status_code": "200"}),
    rec("2026-01-01T00:00:03.000Z", FORE, "codex.api_request", attempt="1",
        **{"http.response.status_code": "200"}),
    rec("2026-01-01T00:00:04.000Z", FORE, "codex.tool_result",
        tool_name="mcp__pycharmapply_patch", call_id="f1",
        success="false", duration_ms="100"),
    rec("2026-01-01T00:00:04.500Z", FORE, "codex.tool_result",
        tool_name="exec_command", call_id="f2", success="true", duration_ms="50"),
    rec("2026-01-01T00:00:06.000Z", FORE, "codex.sse_event",
        **{"event.kind": "response.completed", "input_token_count": "100000",
           "output_token_count": "1000", "cached_token_count": "50000",
           "cache_write_token_count": "0", "reasoning_token_count": "100"}),
]
with open(sys.argv[1], "w") as fh:
    for l in lines:
        fh.write(json.dumps(l, sort_keys=True) + "\n")
FIXLOGF
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNXF"
expect_rc "t12capF0 normalize exits 0" 0 "$RC"
run_cmd "$PY" - "$RUNXF/run-ledger.json" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
i = d["identity"]
a = d["activity"]
f = a["foreign"]
CAP = "01a0c3a6-dd79-7652-bb05-ecb528dd8c5d"
FORE = "01a0c317-53f2-75c3-94cd-5c55f1905890"
assert i["captured_conversation_id"] == CAP
# primary captured metrics: 0 tools, 0 failed tools, captured-conversation
# tokens only (the foreign 151100 tokens never reach the primary record)
assert a["tool_call_count"] == 0 and a["failed_tool_calls"] == 0
assert a["api_request_count"] == 0 and a["failed_api_requests"] == 0
assert a["turn_count"] == 0  # user_prompt rotated out of the raw capture
t = a["token_usage"]
assert t["source"] == "sse-events"
assert (t["input"], t["output"], t["cached"], t["cache_write"],
        t["reasoning"], t["total"]) == (41016, 221128, 36800, 0, 221128, 520072)
assert d["failures"] == []  # the foreign failure is not the captured turn's
# foreign conversation detected + compact aggregate
assert f["present"] is True and f["conversation_count"] == 1
assert f["conversation_ids"] == [FORE]
assert f["api_request_count"] == 2 and f["failed_api_requests"] == 0
assert f["tool_call_count"] == 2 and f["failed_tool_calls"] == 1
assert f["turn_count"] == 1 and f["token_usage_total"] == 151100
assert "captured_conversation_unknown" not in d["evidence_gaps"]
PYCHK
expect_rc "t12capF1 incident reconstruction: captured turn scoped, foreign detected" 0 "$RC"

# Case G — historical incident replay: with the persisted captured
# identity and the real run's 2178 s window, the current
# captured-conversation evidence triggers the intended diagnostics: the
# incident signature (huge generation, zero tools, no attributed API
# request, 100% reasoning share) is detected with explicit signals and
# observed-value evidence. Only the run-level signal is unevaluated (the
# fixture manifest carries no end-of-run Git evidence) — never guessed,
# and foreign conversation 01a0c317 never influences the diagnosis.
run_cmd "$PY" - "$RUNXF/run-ledger.json" <<'PYDIAGF'
import json, sys
dg = json.load(open(sys.argv[1]))["diagnostics"]["pathological_run"]
assert dg["detected"] is True
by_name = {x["name"]: x for x in dg["signals"]}
assert sorted(by_name) == [
    "extreme_reasoning_dominance",
    "huge_generation_on_few_api_requests",
    "long_generation_without_tool_progress",
]
assert by_name["long_generation_without_tool_progress"]["evidence"] == {
    "duration_s": 2178, "output_tokens": 221128, "tool_call_count": 0}
assert by_name["extreme_reasoning_dominance"]["evidence"] == {
    "output_tokens": 221128, "reasoning_tokens": 221128}
assert by_name["huge_generation_on_few_api_requests"]["evidence"] == {
    "api_request_count": 0, "duration_s": 2178,
    "output_tokens": 221128, "tool_call_count": 0}
assert dg["unevaluated"] == [
    {"name": "no_progress_after_long_run", "reason": "missing_evidence"}]
PYDIAGF
expect_rc "t12capF2 incident replay: captured-conversation evidence triggers the diagnostics" 0 "$RC"

# determinism of the scoped normalization (byte-identical re-normalization)
run_cmd cp "$RUNXB/run-ledger.json" "$T12/capb-first.json"
run_cmd cp "$RUNXF/run-ledger.json" "$T12/capf-first.json"
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNXB"
expect_rc "t12capX0 re-normalize B exits 0" 0 "$RC"
run_cmd cmp -s "$RUNXB/run-ledger.json" "$T12/capb-first.json"
expect_rc "t12capX1 re-normalization of B is byte-identical" 0 "$RC"
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNXF"
run_cmd cmp -s "$RUNXF/run-ledger.json" "$T12/capf-first.json"
expect_rc "t12capX2 re-normalization of F is byte-identical" 0 "$RC"

# --------------------------------------------- t12diag diagnostics (v4) --
# Pathological run diagnostics: explicit deterministic signals over the
# normalized captured-scoped metrics. Diagnostic only — the section flags
# behavior for human review; it never terminates anything and never
# changes token budgets or model settings.
#
# diag_write_manifest <run-id> <captured-conv> <start> <end> <start-head>
#                     <end-head> <commit:true|false> <changed> <convs-json>
diag_write_manifest() {
  local rid="$1" cap="$2" st="$3" en="$4" sh="$5" eh="$6" commit="$7" chg="$8" convs="$9"
  cat > "$T12/runs/$rid/capture-manifest.json" <<MANJSON
{
  "schema_version": 1, "run_id": "$rid",
  "kind": "capture",
  "captured_conversation_id": "$cap",
  "start_ts": "$st", "end_ts": "$en",
  "stop_status": "graceful",
  "repo_root": null, "branch": null,
  "starting_head": "$sh", "ending_head": "$eh",
  "starting_tree": "clean", "ending_tree": "clean",
  "changed_file_count": $chg, "lines_added": 0, "lines_deleted": 0,
  "commit_created": $commit,
  "codex_version": null, "codex_acp_version": "1.7.0",
  "collector_version": "0.161.0", "otel_endpoint": "http://127.0.0.1:4318",
  "privacy_mode": "trace-safe-sanitized",
  "raw_trace_files": [], "conversation_ids": $convs,
  "event_counts": {}, "app_versions": ["0.148.0"], "models": [],
  "originators": [], "span_counts": {}, "metric_names": {},
  "log_record_count": 0, "span_count": 0, "metric_series_count": 0
}
MANJSON
}

# Case A — original pathological shape (synthetic): long duration (2178 s),
# one API request, very high reasoning/output (221,128 of 221,128), 0
# tools, 0 failures, no verification, no repository progress.
RUNDA="$T12/runs/run-20260101T000014Z"
mkdir -p "$RUNDA/raw"
diag_write_manifest run-20260101T000014Z conv-incident \
  "2026-01-01T00:00:00Z" "2026-01-01T00:36:18Z" \
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  false 0 '["conv-incident"]'
"$PY" - "$RUNDA/raw/logs.jsonl" <<'FIXLOGDA'
import json, sys
def rec(ts, name, **kw):
    attrs = {"event.timestamp": ts, "event.name": name,
             "conversation.id": "conv-incident", "app.version": "0.148.0"}
    attrs.update(kw)
    return {"resourceLogs": [{"resource": {"attributes": []}, "scopeLogs": [
        {"logRecords": [{"severityNumber": 9,
                         "attributes": [{"key": k, "value": {"stringValue": str(v)}} for k, v in sorted(attrs.items())]}]}]}]}
lines = [
    rec("2026-01-01T00:00:00.000Z", "codex.conversation_starts"),
    rec("2026-01-01T00:00:01.000Z", "codex.user_prompt", prompt_length="64"),
    rec("2026-01-01T00:00:02.000Z", "codex.api_request", attempt="0",
        **{"http.response.status_code": "200", "success": "true"}),
    rec("2026-01-01T00:36:17.500Z", "codex.sse_event",
        **{"event.kind": "response.completed", "input_token_count": "41016",
           "output_token_count": "221128", "cached_token_count": "36800",
           "cache_write_token_count": "0", "reasoning_token_count": "221128"}),
]
with open(sys.argv[1], "w") as fh:
    for l in lines:
        fh.write(json.dumps(l, sort_keys=True) + "\n")
FIXLOGDA
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNDA"
expect_rc "t12diagA0 Case A normalize exits 0" 0 "$RC"
run_cmd "$PY" - "$RUNDA/run-ledger.json" <<'PYDIAGA'
import json, sys
d = json.load(open(sys.argv[1]))
dg = d["diagnostics"]["pathological_run"]
a = d["activity"]
# captured-scoped activity: 1 API request, 0 tools, incident token shape
assert a["api_request_count"] == 1 and a["tool_call_count"] == 0
assert a["failed_tool_calls"] == 0 and d["failures"] == []
t = a["token_usage"]
assert (t["input"], t["output"], t["cached"], t["cache_write"],
        t["reasoning"], t["total"]) == (41016, 221128, 36800, 0, 221128, 520072)
assert dg["detected"] is True
by_name = {x["name"]: x for x in dg["signals"]}
assert sorted(by_name) == [
    "extreme_reasoning_dominance",
    "huge_generation_on_few_api_requests",
    "long_generation_without_tool_progress",
    "no_progress_after_long_run",
]
assert by_name["long_generation_without_tool_progress"]["evidence"] == {
    "duration_s": 2178, "output_tokens": 221128, "tool_call_count": 0}
assert by_name["extreme_reasoning_dominance"]["evidence"] == {
    "output_tokens": 221128, "reasoning_tokens": 221128}
assert by_name["no_progress_after_long_run"]["evidence"] == {
    "changed_file_count": 0, "commit_created": False, "duration_s": 2178,
    "verification_profiles": 0}
assert by_name["huge_generation_on_few_api_requests"]["evidence"] == {
    "api_request_count": 1, "duration_s": 2178,
    "output_tokens": 221128, "tool_call_count": 0}
assert dg["unevaluated"] == []
# foreign is defined (captured identity present) but empty
assert a["foreign"]["present"] is False
PYDIAGA
expect_rc "t12diagA1 Case A: incident shape detected with explicit signals + evidence" 0 "$RC"
run_cmd "$PY" "$LEDGER_PY" show "$RUNDA"
expect_rc "t12diagA2 Case A human ledger show exits 0" 0 "$RC"
expect_contains "t12diagA3 human output names the pathological-run diagnostic" "$CAP_OUT" "PATHOLOGICAL RUN"
expect_contains "t12diagA4 human output lists the fired signals" "$CAP_OUT" "long_generation_without_tool_progress"

# Case B — normal short no-tool response: short duration, small output,
# 0 tools. Must NOT be flagged — tool_count == 0 is not a pathology.
RUNDB="$T12/runs/run-20260101T000015Z"
mkdir -p "$RUNDB/raw"
diag_write_manifest run-20260101T000015Z conv-short \
  "2026-01-01T00:00:00Z" "2026-01-01T00:00:30Z" \
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" \
  false 0 '["conv-short"]'
"$PY" - "$RUNDB/raw/logs.jsonl" <<'FIXLOGDB'
import json, sys
def rec(ts, name, **kw):
    attrs = {"event.timestamp": ts, "event.name": name,
             "conversation.id": "conv-short", "app.version": "0.148.0"}
    attrs.update(kw)
    return {"resourceLogs": [{"resource": {"attributes": []}, "scopeLogs": [
        {"logRecords": [{"severityNumber": 9,
                         "attributes": [{"key": k, "value": {"stringValue": str(v)}} for k, v in sorted(attrs.items())]}]}]}]}
lines = [
    rec("2026-01-01T00:00:00.000Z", "codex.conversation_starts"),
    rec("2026-01-01T00:00:01.000Z", "codex.user_prompt", prompt_length="32"),
    rec("2026-01-01T00:00:02.000Z", "codex.api_request", attempt="0",
        **{"http.response.status_code": "200", "success": "true"}),
    rec("2026-01-01T00:00:05.000Z", "codex.sse_event",
        **{"event.kind": "response.completed", "input_token_count": "1200",
           "output_token_count": "240", "cached_token_count": "1000",
           "cache_write_token_count": "0", "reasoning_token_count": "120"}),
]
with open(sys.argv[1], "w") as fh:
    for l in lines:
        fh.write(json.dumps(l, sort_keys=True) + "\n")
FIXLOGDB
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNDB"
expect_rc "t12diagB0 Case B normalize exits 0" 0 "$RC"
run_cmd "$PY" - "$RUNDB/run-ledger.json" <<'PYDIAGB'
import json, sys
d = json.load(open(sys.argv[1]))
dg = d["diagnostics"]["pathological_run"]
assert d["activity"]["tool_call_count"] == 0  # zero tools, still not flagged
assert dg["detected"] is False and dg["signals"] == []
assert dg["unevaluated"] == []  # everything evaluated, nothing missing
PYDIAGB
expect_rc "t12diagB1 Case B: short no-tool response not flagged, all signals evaluated" 0 "$RC"
run_cmd "$PY" "$LEDGER_PY" show "$RUNDB"
expect_rc "t12diagB2 Case B human ledger show exits 0" 0 "$RC"
expect_contains "t12diagB3 normal run human output is a compact single line" "$CAP_OUT" "no pathological-run signals"
expect_not_contains "t12diagB4 normal run output does not flood with diagnostics" "$CAP_OUT" "PATHOLOGICAL RUN"

# Case C — healthy engineering turn: long duration (2400 s, beyond the
# 1800 s threshold), many tools, repository progress (12 changed files,
# commit created), verification evidence, normal token profile (50%
# reasoning share) -> NOT flagged. Long duration with progress is fine.
RUNDC="$T12/runs/run-20260101T000016Z"
mkdir -p "$RUNDC/raw"
diag_write_manifest run-20260101T000016Z conv-healthy \
  "2026-01-01T00:00:00Z" "2026-01-01T00:40:00Z" \
  "1111111111111111111111111111111111111111" "2222222222222222222222222222222222222222" \
  true 12 '["conv-healthy"]'
cat > "$RUNDC/verify-quick.json" <<'VERIFYC'
{
  "schemaVersion": 1, "profile": "quick", "mode": "run",
  "result": "pass", "exitCode": 0,
  "startedAt": "2026-01-01T00:39:00Z", "finishedAt": "2026-01-01T00:39:20Z",
  "durationMs": 20000, "agentRunId": "run-20260101T000016Z",
  "phases": [
    {"name": "repo_hygiene", "outcome": "passed", "exitCode": 0},
    {"name": "frontend_typecheck", "outcome": "passed", "exitCode": 0}
  ]
}
VERIFYC
"$PY" - "$RUNDC/raw/logs.jsonl" <<'FIXLOGDC'
import json, sys
def rec(ts, name, **kw):
    attrs = {"event.timestamp": ts, "event.name": name,
             "conversation.id": "conv-healthy", "app.version": "0.148.0"}
    attrs.update(kw)
    return {"resourceLogs": [{"resource": {"attributes": []}, "scopeLogs": [
        {"logRecords": [{"severityNumber": 9,
                         "attributes": [{"key": k, "value": {"stringValue": str(v)}} for k, v in sorted(attrs.items())]}]}]}]}
lines = [
    rec("2026-01-01T00:00:00.000Z", "codex.conversation_starts"),
    rec("2026-01-01T00:00:01.000Z", "codex.user_prompt", prompt_length="128"),
]
for i in range(6):
    lines.append(rec("2026-01-01T00:0%d:00.000Z" % (i // 2), "codex.api_request",
                     attempt=str(i), **{"http.response.status_code": "200",
                                        "success": "true"}))
for i in range(1, 13):
    lines.append(rec("2026-01-01T00:0%d:%02d.000Z" % (i // 2, (i * 7) % 60),
                     "codex.tool_result", tool_name="exec_command",
                     call_id="h%d" % i,
                     success="false" if i in (4, 9) else "true",
                     duration_ms="50"))
lines.append(rec("2026-01-01T00:39:00.000Z", "codex.sse_event",
                 **{"event.kind": "response.completed",
                    "input_token_count": "50000", "output_token_count": "90000",
                    "cached_token_count": "40000", "cache_write_token_count": "0",
                    "reasoning_token_count": "45000"}))
with open(sys.argv[1], "w") as fh:
    for l in lines:
        fh.write(json.dumps(l, sort_keys=True) + "\n")
FIXLOGDC
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNDC"
expect_rc "t12diagC0 Case C normalize exits 0" 0 "$RC"
run_cmd "$PY" - "$RUNDC/run-ledger.json" <<'PYDIAGC'
import json, sys
d = json.load(open(sys.argv[1]))
dg = d["diagnostics"]["pathological_run"]
a = d["activity"]
assert a["tool_call_count"] == 12 and a["failed_tool_calls"] == 2
assert d["git_wip"]["commit_created"] is True
assert d["git_wip"]["changed_file_count"] == 12
assert d["verification"]["final_gate"]["result"] == "pass"
assert dg["detected"] is False and dg["signals"] == []
assert dg["unevaluated"] == []
PYDIAGC
expect_rc "t12diagC1 Case C: healthy long engineering turn not flagged" 0 "$RC"

# Case D — tool-heavy failed run: 7 of 12 tool calls failed but bounded
# generation and short duration. The detector exposes ONLY the supported
# failure-related signal; it is not classified as the model-generation
# pathology of the original incident (criteria do not independently
# justify it).
RUNDD="$T12/runs/run-20260101T000017Z"
mkdir -p "$RUNDD/raw"
diag_write_manifest run-20260101T000017Z conv-flaky \
  "2026-01-01T00:00:00Z" "2026-01-01T00:05:00Z" \
  "cccccccccccccccccccccccccccccccccccccccc" "cccccccccccccccccccccccccccccccccccccccc" \
  false 0 '["conv-flaky"]'
"$PY" - "$RUNDD/raw/logs.jsonl" <<'FIXLOGDD'
import json, sys
def rec(ts, name, **kw):
    attrs = {"event.timestamp": ts, "event.name": name,
             "conversation.id": "conv-flaky", "app.version": "0.148.0"}
    attrs.update(kw)
    return {"resourceLogs": [{"resource": {"attributes": []}, "scopeLogs": [
        {"logRecords": [{"severityNumber": 9,
                         "attributes": [{"key": k, "value": {"stringValue": str(v)}} for k, v in sorted(attrs.items())]}]}]}]}
lines = [
    rec("2026-01-01T00:00:00.000Z", "codex.conversation_starts"),
    rec("2026-01-01T00:00:01.000Z", "codex.user_prompt", prompt_length="64"),
]
for i in range(3):
    lines.append(rec("2026-01-01T00:00:%02d.000Z" % (2 + i), "codex.api_request",
                     attempt=str(i), **{"http.response.status_code": "200",
                                        "success": "true"}))
for i in range(1, 13):
    lines.append(rec("2026-01-01T00:00:%02d.500Z" % (3 + i), "codex.tool_result",
                     tool_name="exec_command", call_id="f%d" % i,
                     success="false" if i <= 7 else "true",
                     duration_ms="40"))
lines.append(rec("2026-01-01T00:04:50.000Z", "codex.sse_event",
                 **{"event.kind": "response.completed",
                    "input_token_count": "8000", "output_token_count": "4000",
                    "cached_token_count": "2000", "cache_write_token_count": "0",
                    "reasoning_token_count": "2000"}))
with open(sys.argv[1], "w") as fh:
    for l in lines:
        fh.write(json.dumps(l, sort_keys=True) + "\n")
FIXLOGDD
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNDD"
expect_rc "t12diagD0 Case D normalize exits 0" 0 "$RC"
run_cmd "$PY" - "$RUNDD/run-ledger.json" <<'PYDIAGD'
import json, sys
d = json.load(open(sys.argv[1]))
dg = d["diagnostics"]["pathological_run"]
assert d["activity"]["failed_tool_calls"] == 7
assert dg["detected"] is True
assert [x["name"] for x in dg["signals"]] == ["high_failed_tool_concentration"]
assert dg["signals"][0]["evidence"] == {
    "failed_tool_calls": 7, "tool_call_count": 12}
assert dg["unevaluated"] == []
PYDIAGD
expect_rc "t12diagD1 Case D: only the failure-related signal is exposed" 0 "$RC"

# Case E — foreign telemetry isolation: captured conversation A is a
# small healthy turn; foreign conversation B is extreme (huge tokens,
# many API requests, many failed tools). A must NOT be diagnosed as
# pathological; B's values appear only in activity.foreign and never in
# the diagnostics.
RUNDE="$T12/runs/run-20260101T000018Z"
mkdir -p "$RUNDE/raw"
diag_write_manifest run-20260101T000018Z conv-a-healthy \
  "2026-01-01T00:00:00Z" "2026-01-01T00:10:00Z" \
  "dddddddddddddddddddddddddddddddddddddddd" "dddddddddddddddddddddddddddddddddddddddd" \
  false 0 '["conv-a-healthy", "conv-b-extreme"]'
"$PY" - "$RUNDE/raw/logs.jsonl" <<'FIXLOGDE'
import json, sys
def rec(ts, conv, name, **kw):
    attrs = {"event.timestamp": ts, "event.name": name,
             "conversation.id": conv, "app.version": "0.148.0"}
    attrs.update(kw)
    return {"resourceLogs": [{"resource": {"attributes": []}, "scopeLogs": [
        {"logRecords": [{"severityNumber": 9,
                         "attributes": [{"key": k, "value": {"stringValue": str(v)}} for k, v in sorted(attrs.items())]}]}]}]}
lines = [
    rec("2026-01-01T00:00:00.000Z", "conv-a-healthy", "codex.conversation_starts"),
    rec("2026-01-01T00:00:01.000Z", "conv-a-healthy", "codex.user_prompt", prompt_length="10"),
    rec("2026-01-01T00:00:02.000Z", "conv-a-healthy", "codex.api_request", attempt="0",
        **{"http.response.status_code": "200", "success": "true"}),
    rec("2026-01-01T00:00:05.000Z", "conv-a-healthy", "codex.sse_event",
        **{"event.kind": "response.completed", "input_token_count": "100",
           "output_token_count": "20", "cached_token_count": "30",
           "cache_write_token_count": "0", "reasoning_token_count": "5"}),
    # foreign conversation B: extreme generation + failures
    rec("2026-01-01T00:00:01.000Z", "conv-b-extreme", "codex.user_prompt", prompt_length="99"),
]
for i in range(20):
    lines.append(rec("2026-01-01T00:00:%02d.100Z" % (2 + i // 16), "conv-b-extreme",
                     "codex.api_request", attempt=str(i),
                     **{"http.response.status_code": "500" if i % 4 == 0 else "200",
                        "success": "false" if i % 4 == 0 else "true"}))
for i in range(1, 31):
    lines.append(rec("2026-01-01T00:01:%02d.200Z" % i, "conv-b-extreme",
                     "codex.tool_result", tool_name="exec_command",
                     call_id="x%d" % i,
                     success="false" if i % 2 == 0 else "true",
                     duration_ms="30"))
lines.append(rec("2026-01-01T00:09:50.000Z", "conv-b-extreme", "codex.sse_event",
                 **{"event.kind": "response.completed",
                    "input_token_count": "500000", "output_token_count": "450000",
                    "cached_token_count": "100000", "cache_write_token_count": "0",
                    "reasoning_token_count": "400000"}))
with open(sys.argv[1], "w") as fh:
    for l in lines:
        fh.write(json.dumps(l, sort_keys=True) + "\n")
FIXLOGDE
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNDE"
expect_rc "t12diagE0 Case E normalize exits 0" 0 "$RC"
run_cmd "$PY" - "$RUNDE/run-ledger.json" <<'PYDIAGE'
import json, sys
d = json.load(open(sys.argv[1]))
dg = d["diagnostics"]["pathological_run"]
a = d["activity"]
# captured A: small healthy turn — NOT diagnosed as pathological
assert dg["detected"] is False and dg["signals"] == []
assert dg["unevaluated"] == []  # captured identity present: all evaluated
# extreme foreign B is reported separately, never merged, never diagnosed
f = a["foreign"]
assert f["present"] is True and f["conversation_ids"] == ["conv-b-extreme"]
assert f["api_request_count"] == 20 and f["failed_api_requests"] == 5
assert f["tool_call_count"] == 30 and f["failed_tool_calls"] == 15
assert f["token_usage_total"] == 1450000
assert a["api_request_count"] == 1 and a["tool_call_count"] == 0
PYDIAGE
expect_rc "t12diagE1 Case E: extreme foreign telemetry never changes the captured diagnosis" 0 "$RC"

# Case F — deterministic normalization: the diagnostic-bearing record is
# byte-identical across re-normalization.
run_cmd cp "$RUNDA/run-ledger.json" "$T12/diagA-first.json"
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNDA"
expect_rc "t12diagF0 Case F re-normalize exits 0" 0 "$RC"
run_cmd cmp -s "$RUNDA/run-ledger.json" "$T12/diagA-first.json"
expect_rc "t12diagF1 Case F re-normalization is byte-identical (diagnostics deterministic)" 0 "$RC"

# run context in the ledger: explicit, bounded, idempotent, no inference
RUNCONTEXT_PY="$REPO_ROOT/scripts/observability/runcontext.py"
run_cmd "$PY" "$RUNCONTEXT_PY" set "$RUNA" --task-type "Vertical Slice" --session NEW --task-key "task-slice-01"
expect_rc "t12b run-context set exits 0" 0 "$RC"
expect_file "t12ba run-context file stored in the run dir" "$RUNA/run-context.json"
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNA"
expect_rc "t12bb re-normalize with run context exits 0" 0 "$RC"
run_cmd "$PY" - "$LED" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["context"] == {"task_type": "Vertical Slice", "session_mode": "NEW",
                        "task_key": "task-slice-01", "harness_variant": None}
assert "no_run_context" not in d["evidence_gaps"]
assert d["comparability"]["dimensions"]["task_type"] is True
assert d["comparability"]["dimensions"]["session_mode"] is True
assert d["comparability"]["dimensions"]["harness_variant"] is False
assert "harness_variant" in d["comparability"]["missing"]
assert "task_type" not in d["comparability"]["missing"]
PYCHK
expect_rc "t12bc run context + comparability normalized" 0 "$RC"
run_cmd cp "$LED" "$T12/ledger-with-context.json"
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNA"
run_cmd cmp -s "$LED" "$T12/ledger-with-context.json"
expect_rc "t12bd re-normalization with context is byte-identical" 0 "$RC"

# wrapper context on an explicit run id (stop_status already finalized is fine)
run_cmd env FG_OBS_RUNS_DIR="$T12/runs" bash "$OBS" context run-20260101T000000Z \
  --task-type "Vertical Slice" --session NEW --task-key "task-slice-01" --harness-variant "hv-a"
expect_rc "t12be wrapper context <run-id> exits 0" 0 "$RC"
expect_contains "t12bf wrapper reports the attached run" "$CAP_OUT" "run-20260101T000000Z"
run_cmd "$PY" -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["harness_variant"]=="hv-a" and d["task_type"]=="Vertical Slice" else 1)' "$RUNA/run-context.json"
expect_rc "t12bg idempotent update preserved prior fields + added harness variant" 0 "$RC"

# malformed run-context fails closed (exit 7), raw telemetry untouched
printf '{"schema_version": 1, "task_type": "my full prompt text here", "session_mode": null, "task_key": null, "harness_variant": null}\n' > "$RUNA/run-context.json"
run_cmd "$PY" "$LEDGER_PY" normalize "$RUNA"
expect_rc "t12bh prompt-like run-context value rejected (exit 7)" 7 "$RC"
expect_contains "t12bi malformed-context message names the file" "$CAP_OUT" "run-context"
RAW_AFTER2="$(sha256_file "$RUNA/raw/logs.jsonl")"
expect_eq "t12bj failed normalization left raw telemetry byte-identical" "$RAW_BEFORE" "$RAW_AFTER2"
# restore the valid context and re-normalize for the later wrapper tests
run_cmd "$PY" "$RUNCONTEXT_PY" set "$RUNA" --task-type "Vertical Slice" --session NEW --task-key "task-slice-01" --harness-variant "hv-a"
expect_rc "t12bk context restored" 0 "$RC"

# v1 compatibility: a hand-written v1 record is a valid, self-contained
# document (no v2 keys) and is only upgraded by an explicit re-normalize
cat > "$T12/legacy-v1-ledger.json" <<'V1JSON'
{
  "schema_version": 1,
  "record_name": "fg-agent-run-ledger",
  "run_id": "run-20250101T000000Z",
  "identity": {"conversation_ids": [], "capture_kind": "capture", "repo_root": null,
    "branch": null, "starting_head": null, "ending_head": null,
    "start_ts": "2025-01-01T00:00:00Z", "end_ts": "2025-01-01T00:01:00Z",
    "duration_s": 60, "stop_status": "graceful"},
  "runtime": {"codex_version": "0.148.0", "codex_acp_version": "1.7.0",
    "models": [], "collector_version": "0.161.0", "originators": [],
    "privacy_mode": "trace-safe-sanitized", "app_versions": []},
  "git_wip": {"starting_tree": "clean", "ending_tree": "clean",
    "changed_file_count": 0, "changed_files": [], "changed_files_truncated": false,
    "lines_added": 0, "lines_deleted": 0, "commit_created": false,
    "starting_head": null, "ending_head": null},
  "activity": {"tool_call_count": null, "tool_calls_by_type": {}, "successful_tool_calls": null,
    "failed_tool_calls": null, "shell_command_count": null, "failed_shell_commands": null,
    "file_activity_count": null, "api_request_count": 0, "failed_api_requests": 0,
    "token_usage": {"input": null, "output": null, "cached": null, "cache_write": null,
      "reasoning": null, "total": null, "source": null},
    "turn_count": 0, "time_to_first_tool_action_ms": null,
    "time_to_first_failure_ms": null, "time_to_final_response_ms": null},
  "verification": {"doctor": null, "observability_doctor": null, "profiles": [], "final_gate": null},
  "failures": [],
  "human": {"correction_occurred": null, "categories": [], "annotations": []},
  "evidence_gaps": ["no_telemetry", "no_metrics_file", "token_usage_unavailable",
    "no_end_git_evidence", "no_verification_evidence", "no_doctor_evidence", "no_annotations"]
}
V1JSON
run_cmd "$PY" - "$T12/legacy-v1-ledger.json" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["schema_version"] == 1
assert "context" not in d and "comparability" not in d
assert set(d) == {"schema_version", "record_name", "run_id", "identity",
                  "runtime", "git_wip", "activity", "verification",
                  "failures", "human", "evidence_gaps"}
PYCHK
expect_rc "t12bl historical v1 record remains a valid v1 document (never rewritten)" 0 "$RC"

# bash wrapper: resolve_run_dir, --json, latest symlink, usage errors
ln -sfn run-20260101T000000Z "$T12/runs/latest"
run_cmd env FG_OBS_RUNS_DIR="$T12/runs" bash "$OBS" ledger
expect_rc "t12ad wrapper ledger (latest) exits 0" 0 "$RC"
expect_contains "t12ae wrapper human output names the run" "$CAP_OUT" "run-20260101T000000Z"
run_cmd env FG_OBS_RUNS_DIR="$T12/runs" bash "$OBS" ledger run-20260101T000000Z --json
expect_rc "t12af wrapper ledger --json exits 0" 0 "$RC"
"$PY" -c 'import json,sys; d=json.loads(sys.argv[1]); assert d["run_id"]=="run-20260101T000000Z" and d["schema_version"]==4 and "comparability" in d and "diagnostics" in d' "$CAP_OUT" \
  && ok "t12ag wrapper --json emits the v4 record" || bad "t12ag wrapper --json emits the v4 record"
run_cmd env FG_OBS_RUNS_DIR="$T12/runs" bash "$OBS" ledger "bad id"
expect_rc "t12ah wrapper rejects invalid run id (exit 2)" 2 "$RC"
run_cmd env FG_OBS_RUNS_DIR="$T12/runs" bash "$OBS" ledger no-such-run
expect_rc "t12ai wrapper reports unknown run (exit 6)" 6 "$RC"
run_cmd env FG_OBS_RUNS_DIR="$T12/runs" bash "$OBS" annotate no-such-run --correction no
expect_rc "t12aj annotate on unknown run exits 6" 6 "$RC"
run_cmd env FG_OBS_RUNS_DIR="$T12/runs" bash "$OBS" annotate run-20260101T000000Z
expect_rc "t12ak annotate without --correction exits 2" 2 "$RC"
expect_contains "t12al usage mentions ledger + annotate" "$(bash "$OBS" help)" "annotate <run-id>"
rm -rf "$T12"

# ------------------------------------------------------------ t13 context ---
# `context current` resolves exactly one live product capture deterministically
# (pidfile liveness, same check as status). No timestamp-nearest guessing.
T13="$(mktemp -d "${TMPDIR:-/tmp}/fg-obs-context.XXXXXX")"
mkdir -p "$T13/runs"
LIVE_PID=""
sleep 300 & LIVE_PID=$!
trap 'kill "$LIVE_PID" 2>/dev/null || true' EXIT
mk_live_run() { # mk_live_run <run-id> <kind>
  mkdir -p "$T13/runs/$1/raw"
  printf '%s' "$LIVE_PID" > "$T13/runs/$1/collector.pid"
  printf '{"schema_version": 1, "run_id": "%s", "kind": "%s", "stop_status": "running"}\n' "$1" "$2" > "$T13/runs/$1/capture-manifest.json"
}

# zero live captures
run_cmd env -u CODEX_HOME FG_OBS_RUNS_DIR="$T13/runs" bash "$OBS" context current --task-type Bug --session NEW
expect_rc "t13a zero live captures fails closed (exit 10)" 10 "$RC"
expect_contains "t13b zero-capture message advises start" "$CAP_OUT" "agent-observability start"
expect_no_file "t13c no context file created on failure" "$T13/runs/run-context.json"

# exactly one live product capture
mk_live_run run-20260101T090000Z capture
run_cmd env -u CODEX_HOME FG_OBS_RUNS_DIR="$T13/runs" bash "$OBS" context current --task-type Bug --session NEW
expect_rc "t13d exactly one live capture succeeds" 0 "$RC"
expect_contains "t13e context attached to the resolved run" "$CAP_OUT" "run-20260101T090000Z"
expect_file "t13f run-context.json written in the live run dir" "$T13/runs/run-20260101T090000Z/run-context.json"
run_cmd "$PY" -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["schema_version"]==1 and d["task_type"]=="Bug" and d["session_mode"]=="NEW" and d["task_key"] is None and d["harness_variant"] is None' "$T13/runs/run-20260101T090000Z/run-context.json"
expect_rc "t13g context record has the bounded v1 shape" 0 "$RC"

# idempotent: identical bytes on re-run
run_cmd cp "$T13/runs/run-20260101T090000Z/run-context.json" "$T13/ctx-before.json"
run_cmd env -u CODEX_HOME FG_OBS_RUNS_DIR="$T13/runs" bash "$OBS" context current --task-type Bug --session NEW
run_cmd cmp -s "$T13/runs/run-20260101T090000Z/run-context.json" "$T13/ctx-before.json"
expect_rc "t13h identical re-attach is byte-identical (idempotent)" 0 "$RC"

# partial update preserves existing unrelated fields
run_cmd env -u CODEX_HOME FG_OBS_RUNS_DIR="$T13/runs" bash "$OBS" context current --task-type Bug --session CURRENT --task-key "pair-7"
expect_rc "t13i update with task-key exits 0" 0 "$RC"
run_cmd "$PY" -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["session_mode"]=="CURRENT" and d["task_key"]=="pair-7" and d["harness_variant"] is None and d["task_type"]=="Bug"' "$T13/runs/run-20260101T090000Z/run-context.json"
expect_rc "t13j existing fields preserved on partial update" 0 "$RC"

# fail-closed value validation through the wrapper
run_cmd env -u CODEX_HOME FG_OBS_RUNS_DIR="$T13/runs" bash "$OBS" context current --task-type "Not A Type" --session NEW
expect_rc "t13k invalid task_type fails closed (exit 2)" 2 "$RC"
run_cmd env -u CODEX_HOME FG_OBS_RUNS_DIR="$T13/runs" bash "$OBS" context current --task-type Bug --session "new"
expect_rc "t13l lowercase session enum fails closed (exit 2)" 2 "$RC"
run_cmd env -u CODEX_HOME FG_OBS_RUNS_DIR="$T13/runs" bash "$OBS" context current --task-type Bug --session NEW --task-key "please fix the bug in auth"
expect_rc "t13m prompt-like task_key rejected (exit 2)" 2 "$RC"
run_cmd env -u CODEX_HOME FG_OBS_RUNS_DIR="$T13/runs" bash "$OBS" context current --task-type Bug --session NEW --harness-variant ".leading-dot"
expect_rc "t13n malformed slug (leading dot) rejected (exit 2)" 2 "$RC"
run_cmd "$PY" -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["task_key"]=="pair-7"' "$T13/runs/run-20260101T090000Z/run-context.json"
expect_rc "t13o rejected updates did not modify the stored context" 0 "$RC"
run_cmd env -u CODEX_HOME FG_OBS_RUNS_DIR="$T13/runs" bash "$OBS" context current --task-type Bug
expect_rc "t13p missing --session fails closed (exit 2)" 2 "$RC"
run_cmd env -u CODEX_HOME FG_OBS_RUNS_DIR="$T13/runs" bash "$OBS" context
expect_rc "t13q context without target fails (exit 2)" 2 "$RC"

# multiple live captures -> ambiguous (exit 11), no guessing
mk_live_run run-20260101T090001Z capture
run_cmd env -u CODEX_HOME FG_OBS_RUNS_DIR="$T13/runs" bash "$OBS" context current --task-type Bug --session NEW
expect_rc "t13r multiple live captures fail closed (exit 11)" 11 "$RC"
expect_contains "t13s ambiguity message names the candidates" "$CAP_OUT" "run-20260101T090000Z"
expect_contains "t13t ambiguity message suggests an explicit run id" "$CAP_OUT" "explicit run id"
# explicit run id still works under ambiguity
run_cmd env -u CODEX_HOME FG_OBS_RUNS_DIR="$T13/runs" bash "$OBS" context run-20260101T090001Z --task-type Domain --session CURRENT
expect_rc "t13u explicit run id succeeds despite ambiguity" 0 "$RC"
run_cmd "$PY" -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["task_type"]=="Domain" and d["session_mode"]=="CURRENT"' "$T13/runs/run-20260101T090001Z/run-context.json"
expect_rc "t13v explicit-run context stored in the right dir" 0 "$RC"

# probe runs are diagnostic: never a "current" product capture
rm -f "$T13/runs/run-20260101T090001Z/collector.pid" \
      "$T13/runs/run-20260101T090000Z/collector.pid"
mk_live_run probe-native-20260101T090002Z probe-native
run_cmd env -u CODEX_HOME FG_OBS_RUNS_DIR="$T13/runs" bash "$OBS" context current --task-type Bug --session NEW
expect_rc "t13w probe-only liveness is not a product capture (exit 10)" 10 "$RC"
# dead pid is not live
mkdir -p "$T13/runs/run-20260101T090003Z/raw"
printf '999999\n' > "$T13/runs/run-20260101T090003Z/collector.pid"
printf '{"schema_version": 1, "run_id": "run-20260101T090003Z", "kind": "capture", "stop_status": "running"}\n' > "$T13/runs/run-20260101T090003Z/capture-manifest.json"
run_cmd env -u CODEX_HOME FG_OBS_RUNS_DIR="$T13/runs" bash "$OBS" context current --task-type Bug --session NEW
expect_rc "t13x dead pidfile is not a live capture (exit 10)" 10 "$RC"
kill "$LIVE_PID" 2>/dev/null || true

# context file is git-ignored with the run
run_cmd git -C "$REPO_ROOT" check-ignore -q .artifacts/agent-runs/run-x/run-context.json
expect_rc "t13y run-context.json is git-ignored" 0 "$RC"
rm -rf "$T13"

# ------------------------------------------------- t14 product identity -----
# The normal product-agent Codex home must be established only from evidence
# (override / live CODEX_HOME / registration), NEVER from generic discovery.
# A controller shell with valid $HOME/.codex AND $HOME/.codex-lucid must NOT
# have either inferred as the product home.
T14="$(mktemp -d "${TMPDIR:-/tmp}/fg-obs-t14.XXXXXX")"
T14RT="$T14/product-runtime.json"         # temp; never the real registration
T14HOME="$T14/homes"
mkdir -p "$T14HOME/.codex" "$T14HOME/.codex-lucid"
printf 'model = "t"\n' > "$T14HOME/.codex/config.toml";      printf '{}\n' > "$T14HOME/.codex/auth.json"
printf 'model = "t"\n' > "$T14HOME/.codex-lucid/config.toml"; printf '{}\n' > "$T14HOME/.codex-lucid/auth.json"

# (1) controller with two valid generic homes + no registration -> NOT inferred
run_cmd env -u CODEX_HOME -u CODEX_PATH -u CODEX_SESSION_ID -u FG_PRODUCT_CODEX_HOME HOME="$T14HOME" FG_PRODUCT_RUNTIME_FILE="$T14RT" bash "$OBS" status --json
t14o="$CAP_OUT"
expect_rc "t14a status (controller, no registration) exits 0" 0 "$RC"
expect_eq "t14b product home is not_registered (never inferred as a generic home)" "not_registered" "$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["product_codex_home"]["state"])' "$t14o")"
expect_eq "t14c product home path is empty" "" "$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["product_codex_home"]["path"])' "$t14o")"
expect_eq "t14d generic discovery is ambiguous (two .codex* homes exist)" "ambiguous" "$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["controller_codex_home"]["state"])' "$t14o")"

# (2) config with no registration -> non-actionable
run_cmd env -u CODEX_HOME -u CODEX_PATH -u CODEX_SESSION_ID -u FG_PRODUCT_CODEX_HOME HOME="$T14HOME" FG_PRODUCT_RUNTIME_FILE="$T14RT" bash "$OBS" config
expect_rc "t14e config (no registration) exits 0" 0 "$RC"
expect_not_contains "t14f config (no registration) prints no actionable destination" "$CAP_OUT" "Add to"
expect_not_contains "t14g config (no registration) never says edit the standalone .codex" "$CAP_OUT" "$T14HOME/.codex/config.toml"

# (3) register from a simulated product env -> exact home recorded
run_cmd env -u CODEX_PATH CODEX_HOME="$T14HOME/.codex-lucid" FG_PRODUCT_RUNTIME_FILE="$T14RT" bash "$OBS" product-runtime register
expect_rc "t14h register (simulated product env) exits 0" 0 "$RC"
expect_contains "t14i register reports the recorded home" "$CAP_OUT" "$T14HOME/.codex-lucid"
expect_file "t14j registration artifact written" "$T14RT"
run_cmd "$PY" - "$T14RT" "$T14HOME/.codex-lucid" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["schema_version"] == 1, d
assert d["codex_home"] == sys.argv[2], (d, sys.argv[2])
PYCHK
expect_rc "t14k registration records exactly the registered home" 0 "$RC"

# (4) status/config after registration use the registered home
run_cmd env -u CODEX_HOME -u CODEX_PATH -u CODEX_SESSION_ID -u FG_PRODUCT_CODEX_HOME HOME="$T14HOME" FG_PRODUCT_RUNTIME_FILE="$T14RT" bash "$OBS" status --json
t14o="$CAP_OUT"
expect_eq "t14l status after registration -> registered" "registered" "$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["product_codex_home"]["state"])' "$t14o")"
expect_eq "t14m status product home = the registered .codex-lucid" "$T14HOME/.codex-lucid" "$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["product_codex_home"]["path"])' "$t14o")"
expect_eq "t14n generic home still ambiguous (standalone .codex present)" "ambiguous" "$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["controller_codex_home"]["state"])' "$t14o")"
run_cmd env -u CODEX_HOME -u CODEX_PATH -u CODEX_SESSION_ID -u FG_PRODUCT_CODEX_HOME HOME="$T14HOME" FG_PRODUCT_RUNTIME_FILE="$T14RT" bash "$OBS" config
expect_contains "t14o config after registration targets the registered home" "$CAP_OUT" "Add to $T14HOME/.codex-lucid/config.toml:"

# (5) a standalone .codex (a different generic home) cannot override the
# registered product identity
run_cmd "$PY" - "$T14RT" "$T14HOME/.codex" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["codex_home"] != sys.argv[2], d
PYCHK
expect_rc "t14p registered product identity is not the standalone .codex" 0 "$RC"

# (6) re-registration changes the product identity deterministically
run_cmd env -u CODEX_PATH CODEX_HOME="$T14HOME/.codex-lucid" FG_PRODUCT_RUNTIME_FILE="$T14RT" bash "$OBS" product-runtime register
expect_contains "t14q unchanged re-registration is idempotent" "$CAP_OUT" "unchanged"
run_cmd env -u CODEX_PATH CODEX_HOME="$T14HOME/.codex-other" FG_PRODUCT_RUNTIME_FILE="$T14RT" bash "$OBS" product-runtime register
expect_contains "t14r re-registration replaces stale identity" "$CAP_OUT" "replaced"
expect_eq "t14s registration now points at the new home" "$T14HOME/.codex-other" "$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["codex_home"])' "$T14RT")"

# (7) register without CODEX_HOME fails closed
run_cmd env -u CODEX_HOME -u CODEX_PATH FG_PRODUCT_RUNTIME_FILE="$T14RT" bash "$OBS" product-runtime register
expect_rc "t14t register without CODEX_HOME fails closed (exit 5)" 5 "$RC"

# (8) corrupt registrations fail clearly
printf 'not-json' > "$T14RT"
run_cmd env -u CODEX_HOME -u CODEX_PATH -u CODEX_SESSION_ID -u FG_PRODUCT_CODEX_HOME FG_PRODUCT_RUNTIME_FILE="$T14RT" bash "$OBS" status --json
expect_eq "t14u corrupt (bad json) -> corrupt state" "corrupt" "$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["product_codex_home"]["state"])' "$CAP_OUT")"
run_cmd env -u CODEX_HOME -u CODEX_PATH -u CODEX_SESSION_ID -u FG_PRODUCT_CODEX_HOME FG_PRODUCT_RUNTIME_FILE="$T14RT" bash "$OBS" config
expect_not_contains "t14v config refuses when the registration is corrupt" "$CAP_OUT" "Add to"
printf '{"schema_version": 1, "codex_home": "relative/path"}\n' > "$T14RT"
run_cmd env -u CODEX_HOME -u CODEX_PATH -u CODEX_SESSION_ID -u FG_PRODUCT_CODEX_HOME FG_PRODUCT_RUNTIME_FILE="$T14RT" bash "$OBS" status --json
expect_eq "t14w corrupt (relative home) -> corrupt state" "corrupt" "$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["product_codex_home"]["state"])' "$CAP_OUT")"
printf '{"schema_version": 99, "codex_home": "/x"}\n' > "$T14RT"
run_cmd env -u CODEX_HOME -u CODEX_PATH -u CODEX_SESSION_ID -u FG_PRODUCT_CODEX_HOME FG_PRODUCT_RUNTIME_FILE="$T14RT" bash "$OBS" status --json
expect_eq "t14x corrupt (wrong schema_version) -> corrupt state" "corrupt" "$("$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["product_codex_home"]["state"])' "$CAP_OUT")"
run_cmd env FG_PRODUCT_RUNTIME_FILE="$T14RT" bash "$OBS" product-runtime show
expect_rc "t14y product-runtime show on a corrupt registration exits 7" 7 "$RC"

# (9) privacy: only the four bounded fields are stored; no env value leaks
run_cmd env -u CODEX_PATH CODEX_HOME="$T14HOME/.codex-lucid" CODEX_CONFIG="evil-config-marker" FG_SECRET_TOKEN="sk-super-secret-123" FG_PRODUCT_RUNTIME_FILE="$T14RT" bash "$OBS" product-runtime register
expect_rc "t14z register with arbitrary extra env exits 0" 0 "$RC"
run_cmd "$PY" - "$T14RT" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
assert set(d.keys()) == {"schema_version", "codex_home", "codex_path", "codex_acp_version"}, d
raw = open(sys.argv[1]).read()
assert "sk-super-secret-123" not in raw
assert "evil-config-marker" not in raw
assert "CODEX_CONFIG" not in raw
PYCHK
expect_rc "t14z2 registration stores only the bounded fields; no env leak" 0 "$RC"

rm -rf "$T14" "$TESTRT_DIR"


# --------------------------------------------------- t15 liveness (EPERM) ---
# Cross-identity liveness: a collector owned by a different identity cannot be
# signaled (EPERM) but is ALIVE. Simulated deterministically with NO second OS
# user: for a non-root user, os.kill(1, 0) -> EPERM (init/launchd is root-owned),
# so PID 1 stands in for a controller-owned collector. Under root PID 1 is
# signalable, so the integration cases skip; the mocked-os.kill unit case below
# is environment-independent and always runs.
LIVENESS_PY="$REPO_ROOT/scripts/observability/liveness.py"

# t15a/b: canonical semantic via mocked os.kill (no environment dependency):
# success -> signalable (alive), EPERM -> denied (alive), ESRCH -> dead.
run_cmd env FG_LIVENESS_DIR="$REPO_ROOT/scripts/observability" "$PY" -c '
import os, sys
sys.path.insert(0, os.environ["FG_LIVENESS_DIR"])
import liveness
real = os.kill
def sig(p, s): return None
def eperm(p, s): raise PermissionError("simulated EPERM")
def esrch(p, s): raise ProcessLookupError("simulated ESRCH")
os.kill = sig;   assert liveness.classify("4242") == "signalable" and liveness.is_alive("4242") is True
os.kill = eperm; assert liveness.classify("4242") == "denied"     and liveness.is_alive("4242") is True
os.kill = esrch; assert liveness.classify("4242") == "dead"       and liveness.is_alive("4242") is False
os.kill = real
print("semantic-ok")
'
expect_rc "t15a canonical semantic (mocked os.kill): ok->signalable, EPERM->denied(alive), ESRCH->dead" 0 "$RC"
expect_contains "t15b mocked-semantic probe printed its marker" "$CAP_OUT" "semantic-ok"

if [ "$(id -u)" -eq 0 ]; then
  skip "t15 cross-identity EPERM integration cases require a non-root user (running as root)"
else
  EPERM_PID=1
  T15="$(mktemp -d "${TMPDIR:-/tmp}/fg-obs-liveness.XXXXXX")"
  mkdir -p "$T15/runs"
  # a pid that is reliably dead (ESRCH) on this platform
  DEAD_PID=""
  for cand in 4194305 2147483646 99999999; do
    if [ "$("$PY" "$LIVENESS_PY" classify "$cand" 2>/dev/null)" = "dead" ]; then DEAD_PID="$cand"; break; fi
  done
  [ -n "$DEAD_PID" ] && ok "t15c a dead (ESRCH) pid was found for the fixture" || bad "t15c a dead (ESRCH) pid was found for the fixture"

  mk15() { # mk15 <run-id> <kind> <pid>
    mkdir -p "$T15/runs/$1/raw"
    printf '%s' "$3" > "$T15/runs/$1/collector.pid"
    printf '{"schema_version": 1, "run_id": "%s", "kind": "%s", "stop_status": "running"}\n' "$1" "$2" > "$T15/runs/$1/capture-manifest.json"
  }
  env15() { # run agent-observability under the temp runs dir, outside a product session
    env -u CODEX_HOME -u CODEX_SESSION_ID FG_OBS_RUNS_DIR="$T15/runs" bash "$OBS" "$@"
  }

  # 4: status reports a permission-denied (EPERM) collector as running
  mk15 run-15-1 capture "$EPERM_PID"
  run_cmd env15 status
  expect_contains "t15d status reports a permission-denied (EPERM) collector as running" "$CAP_OUT" "running (run run-15-1, pid 1)"

  # 5: context current resolves one permission-denied live capture
  run_cmd env15 context current --task-type Bug --session NEW
  expect_rc "t15e context current resolves the permission-denied live capture" 0 "$RC"
  expect_contains "t15f context attached to the EPERM run" "$CAP_OUT" "run-15-1"
  expect_file "t15g run-context.json written in the EPERM run dir" "$T15/runs/run-15-1/run-context.json"

  # current-run resolves the same single EPERM capture
  run_cmd env15 current-run
  expect_rc "t15h current-run exits 0 with one EPERM capture" 0 "$RC"
  expect_eq "t15i current-run prints just the run id" "run-15-1" "$CAP_OUT"

  # 7 (+11 no-timestamp-guess): two permission-denied captures are ambiguous
  mk15 run-15-2 capture "$EPERM_PID"
  run_cmd env15 context current --task-type Bug --session NEW
  expect_rc "t15j two EPERM captures are ambiguous (exit 11, not newest-wins)" 11 "$RC"
  run_cmd env15 current-run
  expect_rc "t15k current-run is ambiguous with two EPERM captures (exit 11)" 11 "$RC"

  # 6: zero live captures still fails closed
  rm -f "$T15/runs"/run-*/collector.pid 2>/dev/null || true
  run_cmd env15 context current --task-type Bug --session NEW
  expect_rc "t15l zero live captures fails closed (exit 10)" 10 "$RC"
  run_cmd env15 current-run
  expect_rc "t15m current-run zero live captures fails closed (exit 10)" 10 "$RC"

  # a dead (ESRCH) pid is not a live capture
  mk15 run-15-3 capture "$DEAD_PID"
  run_cmd env15 current-run
  expect_rc "t15n dead (ESRCH) pid is not a live capture (exit 10)" 10 "$RC"

  # 8: probe runs are excluded
  rm -f "$T15/runs"/run-*/collector.pid 2>/dev/null || true
  mk15 probe-native-15 probe-native "$EPERM_PID"
  run_cmd env15 current-run
  expect_rc "t15o probe runs are excluded from current-run (exit 10)" 10 "$RC"

  rm -rf "$T15"
fi


# ---------------------------------------------------------------- summary ---
printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf 'agent-observability tests: PASS (%d checks, %d skipped%s)\n' \
    "$PASS" "$SKIP" "${E2E_SKIPPED:+ — e2e collector suite skipped}"
  exit 0
fi
printf 'agent-observability tests: FAIL (%d failed, %d passed, %d skipped)\n' "$FAIL" "$PASS" "$SKIP"
printf 'failed: %s\n' "${FAILED[*]}"
exit 1
