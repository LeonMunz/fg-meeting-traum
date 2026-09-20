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
#   * probe client usage contract
#   * CODEX_HOME/CODEX_PATH resolution: unset-env discovery, explicit
#     authority, invalid/ambiguous fail-closed (deterministic, sandbox-safe)
#   * ACP probe-client contract: session/prompt params match the exact
#     codex-acp 1.7.0 schema (fake-agent fixture, deterministic)
#   * collector-dependent e2e (start/stop idempotency + fake-secret
#     sanitization + doctor): executed only when a collector binary is
#     present and no capture is already running; otherwise SKIPPED
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
run_cmd bash "$OBS" config
out="$CAP_OUT"
expect_rc "t02a config exits 0" 0 "$RC"
expect_contains "t02b config emits [otel] section" "$out" "[otel]"
expect_contains "t02c config keeps log_user_prompt false" "$out" "log_user_prompt = false"
expect_contains "t02d config points at loopback" "$out" "127.0.0.1:4318"
expect_contains "t02e config overrides metrics exporter" "$out" "metrics_exporter"
expect_contains "t02f config explains repo limitation" "$out" "cannot"
expect_contains "t02g config never claims to edit user config" "$out" "never"

# ------------------------------------------------------------ t03 gitignore --
run_cmd git -C "$REPO_ROOT" check-ignore -q .artifacts/agent-runs/run-x/raw/logs.jsonl
expect_rc "t03a trace files are git-ignored" 0 "$RC"
run_cmd git -C "$REPO_ROOT" check-ignore -q .artifacts/agent-observability/otelcol/0.161.0/otelcol
expect_rc "t03b collector binary location is git-ignored" 0 "$RC"
run_cmd git -C "$REPO_ROOT" check-ignore -q .artifacts/agent-runs/probe-native-x/capture-manifest.json
expect_rc "t03c manifest is git-ignored" 0 "$RC"

# ------------------------------------------------------------------ t04 status -
before_tree="$(git -C "$REPO_ROOT" status --porcelain)"
run_cmd bash "$OBS" status
expect_rc "t04a status (no collector) exits 0" 0 "$RC"
expect_contains "t04b status shows endpoint" "$CAP_OUT" "127.0.0.1:4318"
run_cmd bash "$OBS" status --json
out="$CAP_OUT"
expect_rc "t04c status --json exits 0" 0 "$RC"
"$PY" - "$out" <<'PYCHK' >/dev/null 2>&1
import json, sys
d = json.loads(sys.argv[1])
assert d["schema_version"] == 1
assert d["tool"] == "agent-observability"
assert d["running"]["state"] in ("running", "stopped")
assert d["codex_otel_config"]["state"] in ("configured", "absent", "unknown", "not_checked")
assert d["codex_home"]["state"] in ("explicit", "discovered", "not_found", "ambiguous", "invalid")
assert "path" in d["codex_home"]
assert d["endpoint"].startswith("http://127.0.0.1:")
assert set(d["versions"]) == {"codex", "codex_acp", "collector"}
PYCHK
expect_rc "t04d status --json schema valid" 0 "$?"
run_cmd bash "$OBS" status --json
shape1="$("$PY" -c 'import json,sys; d=json.loads(sys.argv[1]); print(sorted(d.keys()))' "$CAP_OUT")"
run_cmd bash "$OBS" status --json
shape2="$("$PY" -c 'import json,sys; d=json.loads(sys.argv[1]); print(sorted(d.keys()))' "$CAP_OUT")"
expect_eq "t04e status --json structure deterministic" "$shape1" "$shape2"
after_tree="$(git -C "$REPO_ROOT" status --porcelain)"
expect_eq "t04f status did not mutate the working tree" "$before_tree" "$after_tree"

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
    run_cmd bash "$OBS" stop
    expect_rc "t05k stop is idempotent (already stopped) exit 0" 0 "$RC"
    ststate="$(bash "$OBS" status --json | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["running"]["state"])')"
    expect_eq "t05l status reports stopped" "stopped" "$ststate"

    latest="$(bash "$OBS" status --json | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["latest_run"])')"
    man="$REPO_ROOT/.artifacts/agent-runs/$latest/capture-manifest.json"
    [ -f "$man" ] && ok "t05m manifest exists after stop" || bad "t05m manifest exists after stop"
    mstat="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["stop_status"])' "$man" 2>/dev/null || true)"
    expect_eq "t05n manifest stop_status is graceful" "graceful" "$mstat"
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
"$PY" - "$PINS" <<'PYCHK' >/dev/null 2>&1
import json, re, sys
pins = json.load(open(sys.argv[1]))
c = pins["collector"]
assert re.fullmatch(r"\d+\.\d+\.\d+", c["version"])
assert set(c["assets"]) == {"darwin_arm64", "darwin_amd64", "linux_amd64"}
for platform, a in c["assets"].items():
    assert re.fullmatch(r"[0-9a-f]{64}", a["sha256"]), platform
    assert a["file"].startswith("otelcol-contrib_"), platform
PYCHK
expect_rc "t07a pins.json schema + checksums valid" 0 "$?"

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

t10json_state() { "$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["codex_home"]["state"])' "$1" 2>/dev/null || true; }
t10json_path()  { "$PY" -c 'import json,sys; print(json.loads(sys.argv[1])["codex_home"]["path"])' "$1" 2>/dev/null || true; }

# missing: no candidates at all -> fail closed
run_cmd env -u CODEX_HOME -u CODEX_PATH HOME="$T10/empty" bash "$OBS" native-probe
expect_rc "t10a native-probe fails closed when no Codex home is discoverable (exit 5)" 5 "$RC"
expect_contains "t10b diagnostic advises exporting CODEX_HOME" "$CAP_OUT" "export CODEX_HOME"

# invalid candidate (config.toml without auth.json) -> rejected, fail closed
run_cmd env -u CODEX_HOME -u CODEX_PATH HOME="$T10/noauth" bash "$OBS" native-probe
expect_rc "t10c native-probe fails closed for a home missing auth.json (exit 5)" 5 "$RC"

# valid candidate, CODEX_HOME unset -> discovered (asserted via read-only status --json)
run_cmd env -u CODEX_HOME -u CODEX_PATH HOME="$T10/home" bash "$OBS" status --json
t10out="$CAP_OUT"
expect_rc "t10d status with unset CODEX_HOME exits 0" 0 "$RC"
expect_eq "t10e unset CODEX_HOME discovers the normal Codex home" "discovered" "$(t10json_state "$t10out")"
expect_eq "t10f discovered path is the synthetic $HOME/.codex" "$T10/home/.codex" "$(t10json_path "$t10out")"

# ambiguous: two valid homes -> ambiguous + fail closed
run_cmd env -u CODEX_HOME -u CODEX_PATH HOME="$T10/amb" bash "$OBS" status --json
expect_eq "t10g multiple valid homes report ambiguous" "ambiguous" "$(t10json_state "$CAP_OUT")"
run_cmd env -u CODEX_HOME -u CODEX_PATH HOME="$T10/amb" bash "$OBS" native-probe
expect_rc "t10h native-probe fails closed on ambiguous homes (exit 5)" 5 "$RC"

# explicit CODEX_HOME stays authoritative (wins over discovery)
run_cmd env -u CODEX_PATH CODEX_HOME="$T10/home/.codex" HOME="$T10/amb" bash "$OBS" status --json
t10out="$CAP_OUT"
expect_eq "t10i explicit CODEX_HOME is authoritative" "explicit" "$(t10json_state "$t10out")"
expect_eq "t10j explicit path preserved" "$T10/home/.codex" "$(t10json_path "$t10out")"

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
"$PY" - "$T11PARAMS" <<'PYCHK' >/dev/null 2>&1
import json, sys
params = json.loads(open(sys.argv[1]).readline())
assert params["sessionId"] == "fake-session-0001"
assert isinstance(params["prompt"], list) and len(params["prompt"]) >= 1
assert all(b.get("type") == "text" and isinstance(b.get("text"), str) and b["text"] for b in params["prompt"])
assert "content" not in params
PYCHK
expect_rc "t11e emitted prompt request matches the exact codex-acp 1.7.0 schema" 0 "$?"
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
