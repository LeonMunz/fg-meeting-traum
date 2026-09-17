#!/usr/bin/env bash
#
# Tests for scripts/agent-doctor.sh (the read-only environment doctor).
#
# Run:  bash scripts/tests/agent-doctor.test.sh
#
# Requires: bash, node (for JSON validation), git. The doctor itself must
# work even when node is missing — one of the tests simulates exactly that
# via a restricted PATH.
#
# Coverage:
#   * --help and usage errors (exit code 2)
#   * human mode: capability matrix, allowed status values
#   * JSON mode: schema, stable capability order, summary consistency
#   * JSON structure determinism across runs
#   * non-mutation of the working tree (both modes)
#   * no secrets in output
#   * simulated blocker: missing runtimes (restricted PATH)
#   * simulated blocker: missing browser (empty PLAYWRIGHT_BROWSERS_PATH)
#   * blocked-launch classification + cause sanitization (sourced helpers)
#   * read-only contract markers in the doctor source

set -Eeuo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DOCTOR="$REPO_ROOT/scripts/agent-doctor.sh"

PASS=0
FAIL=0
FAILED=()

ok()   { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); FAILED+=("$1"); printf 'FAIL %s\n' "$1"; }

# Runs a command that is allowed to fail; sets CAP_OUT and RC.
CAP_OUT=""
RC=0
run_cmd() {
  RC=0
  set +e
  CAP_OUT="$("$@" 2>&1)" || RC=$?
  set -e
}

check() { # check <name> <command...>
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi
}

expect_rc() { # expect_rc <name> <expected-rc> <actual-rc>
  if [ "$2" -eq "$3" ]; then ok "$1"; else bad "$1 (expected rc=$2, got rc=$3)"; fi
}

expect_contains() { # expect_contains <name> <haystack> <needle>
  case "$2" in
    *"$3"*) ok "$1" ;;
    *) bad "$1 (missing: $3)" ;;
  esac
}

expect_not_contains() { # expect_not_contains <name> <haystack> <needle>
  case "$2" in
    *"$3"*) bad "$1 (found: $3)" ;;
    *) ok "$1" ;;
  esac
}

expect_eq() { # expect_eq <name> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected: $2 | actual: $3)"; fi
}

EXPECTED_CAPABILITIES=(
  repo_workspace node_runtime npm uv_runtime python_runtime
  frontend_deps backend_deps database frontend_gate backend_gate quick_gate
  playwright_runtime chromium_launch e2e_gate network
)

json_field() { # json_field <json> <capability-name> -> prints status
  node -e '
    const fs = require("fs");
    const d = JSON.parse(fs.readFileSync(0, "utf8"));
    const c = (d.capabilities || []).find((x) => x.name === process.argv[1]);
    if (!c) process.exit(2);
    console.log(c.status);
  ' "$2" 2>/dev/null <<<"$1"
}

BASH_BIN="$(command -v bash)"


# ------------------------------------------------------------- t01 help -----
run_cmd bash "$DOCTOR" --help
out="$CAP_OUT"; rc="$RC"
expect_rc "t01a --help exits 0" 0 "$rc"
expect_contains "t01b --help shows tool name" "$out" "agent-doctor"
expect_contains "t01c --help documents status values" "$out" "unavailable"
expect_contains "t01d --help documents exit codes" "$out" "internal doctor failure"

# --------------------------------------------------------- t02 usage errors -
run_cmd bash "$DOCTOR" --bogus
expect_rc "t02a unknown flag exits 2" 2 "$RC"
run_cmd bash "$DOCTOR" --json --help
expect_rc "t02b multiple flags exit 2" 2 "$RC"

# --------------------------------------------------------- t03 human mode ---
run_cmd bash "$DOCTOR"
out="$CAP_OUT"; rc="$RC"
if [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ]; then ok "t03a human mode exit code in {0,1}"; else bad "t03a human mode exit code in {0,1} (got $rc)"; fi
expect_contains "t03b human mode has summary" "$out" "Summary: 15 capabilities"

# Every capability name appears with a valid status as its second column.
rows="$(printf '%s\n' "$out" | awk '$2 ~ /^(available|blocked|unavailable|unknown)$/ { print $1 }')"
for cap in "${EXPECTED_CAPABILITIES[@]}"; do
  expect_contains "t03c capability row: $cap" "$rows" "$cap"
done

# No line may use an invalid status value in the status column.
badstatus="$(printf '%s\n' "$out" | awk 'NR>4 && $1 !~ /^(CAPABILITY|Summary:|Result:|Repo:|Platform:)/ && $2 ~ /avail|block|unknown/ && $2 !~ /^(available|blocked|unavailable|unknown)$/ { print $2 }' | head -n1 || true)"
expect_eq "t03d no invalid status tokens" "" "$badstatus"

# ----------------------------------------------------------- t04 json mode --
run_cmd bash "$DOCTOR" --json
out="$CAP_OUT"; rc="$RC"
if [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ]; then ok "t04a json mode exit code in {0,1}"; else bad "t04a json mode exit code in {0,1} (got $rc)"; fi

validator_out="$(FG_DOCTOR_TEST_REPO_ROOT="$REPO_ROOT" node -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(0, "utf8"));
const errs = [];
const eq = (a, b, m) => { if (a !== b) errs.push(m); };
const EXPECTED = '"$(printf '%s ' "${EXPECTED_CAPABILITIES[@]}" | node -e 'const t=require("fs").readFileSync(0,"utf8"); console.log(JSON.stringify(t.trim().split(/\s+/)))')"';
const ALLOWED = new Set(["available", "blocked", "unavailable", "unknown"]);
eq(d.schema_version, 1, "schema_version");
eq(d.tool, "agent-doctor", "tool");
if (!Array.isArray(d.capabilities)) errs.push("capabilities not an array");
else {
  eq(d.capabilities.map((c) => c.name).join("|"), EXPECTED.join("|"), "capability names/order");
  d.capabilities.forEach((c, i) => {
    if (typeof c.detail !== "string" || c.detail.length === 0) errs.push("cap[" + i + "] detail");
    if (!ALLOWED.has(c.status)) errs.push("cap[" + i + "] status=" + c.status);
    for (const k of Object.keys(c)) if (!["name", "status", "detail"].includes(k)) errs.push("cap[" + i + "] extra key " + k);
  });
}
if (!d.repo || d.repo.root !== process.env.FG_DOCTOR_TEST_REPO_ROOT) errs.push("repo.root");
if (typeof (d.repo || {}).writable !== "boolean") errs.push("repo.writable");
if (!d.environment || typeof d.environment.platform !== "string") errs.push("environment");
const s = d.summary;
if (!s) errs.push("summary missing");
else {
  const caps = d.capabilities || [];
  const cnt = (st) => caps.filter((c) => c.status === st).length;
  eq(s.total, caps.length, "summary.total");
  eq(s.available, cnt("available"), "summary.available");
  eq(s.blocked, cnt("blocked"), "summary.blocked");
  eq(s.unavailable, cnt("unavailable"), "summary.unavailable");
  eq(s.unknown, cnt("unknown"), "summary.unknown");
  eq(s.overall, s.available === s.total ? "ok" : "degraded", "summary.overall");
}
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
' <<<"$out" 2>&1)"; rc=$?
expect_rc "t04b json schema valid" 0 "$rc"
[ -n "$validator_out" ] && printf '%s\n' "$validator_out"

# -------------------------------------------- t05 json structure determinism -
run_cmd bash "$DOCTOR" --json
out1="$CAP_OUT"
run_cmd bash "$DOCTOR" --json
out2="$CAP_OUT"
shape1="$(node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  console.log(Object.keys(d).join("|") + " :: " + d.capabilities.map((c) => c.name + "[" + Object.keys(c).join("") + "]").join(","));
' <<<"$out1")"
shape2="$(node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  console.log(Object.keys(d).join("|") + " :: " + d.capabilities.map((c) => c.name + "[" + Object.keys(c).join("") + "]").join(","));
' <<<"$out2")"
expect_eq "t05 json structure deterministic across runs" "$shape1" "$shape2"

# ------------------------------------------------- t06 non-mutation --------
before_tree="$(git -C "$REPO_ROOT" status --porcelain)"
before_head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
bash "$DOCTOR" >/dev/null 2>&1 || true
bash "$DOCTOR" --json >/dev/null 2>&1 || true
after_tree="$(git -C "$REPO_ROOT" status --porcelain)"
after_head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
expect_eq "t06a working tree unchanged" "$before_tree" "$after_tree"
expect_eq "t06b HEAD unchanged" "$before_head" "$after_head"
expect_not_contains "t06c doctor never references reset_e2e" "$(cat "$DOCTOR")" "reset_e2e"
expect_not_contains "t06d doctor never executes DROP SCHEMA" "$(cat "$DOCTOR")" "DROP SCHEMA"
expect_contains "t06e database probe is SELECT 1 only" "$(cat "$DOCTOR")" "SELECT 1"

# ------------------------------------------------------ t07 no secrets ------
run_cmd env MY_FAKE_SECRET=supersecretpassword123 bash "$DOCTOR" --json
expect_not_contains "t07 no secret values in json output" "$CAP_OUT" "supersecretpassword123"

# ------------------------------------ t08 simulated blocker: missing runtimes
FAKE_BIN="$(mktemp -d)"
for tool in git sed tr uname; do
  target="$(command -v "$tool" 2>/dev/null || true)"
  [ -n "$target" ] && ln -s "$target" "$FAKE_BIN/$tool"
done
run_cmd env PATH="$FAKE_BIN" "$BASH_BIN" "$DOCTOR" --json
out="$CAP_OUT"; rc="$RC"
expect_rc "t08a restricted PATH still exits 1 (degraded)" 1 "$rc"
expect_eq "t08b node_runtime unavailable" "unavailable" "$(json_field "$out" node_runtime)"
expect_eq "t08c npm unavailable" "unavailable" "$(json_field "$out" npm)"
expect_eq "t08d uv_runtime unavailable" "unavailable" "$(json_field "$out" uv_runtime)"
expect_eq "t08e playwright_runtime unknown without node" "unknown" "$(json_field "$out" playwright_runtime)"
expect_eq "t08f chromium_launch skipped (unavailable, not blocked)" "unavailable" "$(json_field "$out" chromium_launch)"
expect_eq "t08g e2e_gate unavailable" "unavailable" "$(json_field "$out" e2e_gate)"
expect_eq "t08h frontend_deps still diagnosed (available)" "available" "$(json_field "$out" frontend_deps)"
expect_eq "t08i python_runtime still diagnosed via venv (available)" "available" "$(json_field "$out" python_runtime)"
dbst="$(json_field "$out" database)"
case "$dbst" in
  available|blocked|unavailable|unknown) ok "t08j database still diagnosed (${dbst})" ;;
  *) bad "t08j database still diagnosed (got: ${dbst:-<missing>})" ;;
esac
rm -rf "$FAKE_BIN"

# --------------------------------- t09 simulated blocker: missing browser ---
EMPTY_PW="$(mktemp -d)"
run_cmd env PLAYWRIGHT_BROWSERS_PATH="$EMPTY_PW" bash "$DOCTOR" --json
out="$CAP_OUT"; rc="$RC"
expect_rc "t09a empty browser path exits 1" 1 "$rc"
expect_eq "t09b playwright_runtime unavailable" "unavailable" "$(json_field "$out" playwright_runtime)"
expect_eq "t09c chromium_launch unavailable (not launched)" "unavailable" "$(json_field "$out" chromium_launch)"
expect_eq "t09d e2e_gate unavailable" "unavailable" "$(json_field "$out" e2e_gate)"
expect_eq "t09e node_runtime unaffected (available)" "available" "$(json_field "$out" node_runtime)"
expect_eq "t09f database unaffected" "$(json_field "$(env PLAYWRIGHT_BROWSERS_PATH="$EMPTY_PW" bash "$DOCTOR" --json 2>/dev/null)" database)" "$(json_field "$out" database)"
rm -rf "$EMPTY_PW"

# --------------------------- t10 blocked-launch classification (sourced lib)
FIXTURE="$(mktemp)"
{
  printf 'browserType.launch: Target page, context or browser has been closed\n'
  printf 'Browser logs:\n\n'
  printf '<launching> /Users/leo/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell --user-data-dir=/var/folders/_9/pqvgd3wd6hj_rfyb0pq_7n_h0000gn/T/playwright_chromiumdev_profile-kTHMhb --headless\n'
  printf '<launched> pid=56600\n'
  printf '[pid=56600][err] [0917/223153.322814:ERROR:base/i18n/icu_util.cc:177] icudtl.dat not found in bundle\n'
  printf '[pid=56600][err] [0917/223153.322968:ERROR:base/i18n/icu_util.cc:232] Invalid file descriptor to ICU data received.\n'
  printf '\033[2m  - [pid=56600][err] \033[0917/223153.322814:ERROR:base/i18n/icu_util.cc:177] icudtl.dat not found in bundle\033[22m\n'
  printf '[pid=56600] <gracefully close start>\n'
} >"$FIXTURE"

cause="$(FG_DOCTOR_SOURCE_ONLY=1 bash -c 'source "$0" >/dev/null 2>&1; sanitize_launch_error' "$DOCTOR" <"$FIXTURE" 2>/dev/null)"
expect_eq "t10a blocked-launch cause extracted" "icudtl.dat not found in bundle" "$cause"
expect_not_contains "t10b no raw user tmp folder in cause" "$cause" "pqvgd3wd6hj_rfyb0pq_7n_h0000gn"
if printf '%s' "$cause" | LC_ALL=C grep -q '[[:cntrl:]]'; then bad "t10c cause has no control characters"; else ok "t10c cause has no control characters"; fi
[ "${#cause}" -le 200 ] && ok "t10d cause length <= 200" || bad "t10d cause length <= 200 (${#cause})"

FIXTURE2="$(mktemp)"
printf '[pid=42][err] profile at /var/folders/_9/pqvgd3wd6hj_rfyb0pq_7n_h0000gn/T/pw-profile failed to open\n' >"$FIXTURE2"
cause2="$(FG_DOCTOR_SOURCE_ONLY=1 bash -c 'source "$0" >/dev/null 2>&1; sanitize_launch_error' "$DOCTOR" <"$FIXTURE2" 2>/dev/null)"
expect_contains "t10e tmp path scrubbed" "$cause2" "/var/folders/<tmp>"
expect_not_contains "t10f raw tmp folder scrubbed" "$cause2" "pqvgd3wd6hj_rfyb0pq_7n_h0000gn"
rm -f "$FIXTURE" "$FIXTURE2"

map0="$(FG_DOCTOR_SOURCE_ONLY=1 bash -c 'source "$0" >/dev/null 2>&1; launch_status_for_rc 0' "$DOCTOR" 2>/dev/null)"
map1="$(FG_DOCTOR_SOURCE_ONLY=1 bash -c 'source "$0" >/dev/null 2>&1; launch_status_for_rc 1' "$DOCTOR" 2>/dev/null)"
map124="$(FG_DOCTOR_SOURCE_ONLY=1 bash -c 'source "$0" >/dev/null 2>&1; launch_status_for_rc 124' "$DOCTOR" 2>/dev/null)"
expect_eq "t10g rc 0 -> available" "available" "$map0"
expect_eq "t10h rc 1 -> blocked" "blocked" "$map1"
expect_eq "t10i rc 124 -> blocked" "blocked" "$map124"

# ---------------------------------------------------------------- summary ---
printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf 'agent-doctor tests: PASS (%d checks)\n' "$PASS"
  exit 0
fi
printf 'agent-doctor tests: FAIL (%d failed, %d passed)\n' "$FAIL" "$PASS"
printf 'failed: %s\n' "${FAILED[*]}"
exit 1
