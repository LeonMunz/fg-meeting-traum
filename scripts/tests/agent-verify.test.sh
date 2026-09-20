#!/usr/bin/env bash
#
# Tests for scripts/agent-verify.sh, focused on the optional
# --summary-json machine-readable run summary.
#
# Run:  bash scripts/tests/agent-verify.test.sh
#
# Requires: bash, node (for JSON validation), git.
#
# No real verification profile is executed: the phase tools (git, npm, uv)
# are replaced by deterministic PATH shims that exit with scripted status
# codes — the same restricted-PATH convention the doctor tests use.
# agent-verify.sh itself always runs with its real toolchain (bash, mktemp,
# date, dirname, mv, rm); no production code path is altered.
#
# Coverage:
#   * --help documents the flag, the schema, and the exit codes
#   * usage errors (missing path, doubled flag)
#   * simulated success: valid schemaVersion-1 JSON, all phases passed,
#     exact announced commands, stable phase order
#   * simulated fail-fast: process rc == JSON exitCode, exactly one failed
#     phase, all later phases not_run (exitCode null)
#   * no file without --summary-json; identical human output with/without
#     the flag (timing normalized)
#   * invalid / missing / unwritable target directory rejected before any
#     phase runs; no parent directories created
#   * plan rejects --summary-json and stays read-only
#   * relative paths resolve against the caller's working directory
#   * no leftover temporary files
#   * no secrets or environment values in the summary
#   * FG_AGENT_RUN_ID correlation: agentRunId recorded when set, null
#     otherwise, invalid values rejected before any phase runs
#   * profile matrix (simulated success): every executable profile (quick,
#     frontend, backend, core, e2e, full) produces a valid schemaVersion-1
#     summary whose phases match the script's own read-only plan output
#     (names, commands, stable order); e2e/full run with the reset opt-in
#     set only for the simulated shim run
#   * multi-phase fail-fast (backend): passed -> failed -> not_run with
#     identical top-level and process exit codes
#   * Playwright arguments (e2e and full): present in the announced command,
#     JSON-escaped in the summary, no environment leakage

set -Eeuo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VERIFY="$REPO_ROOT/scripts/agent-verify.sh"

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

expect_file() { # expect_file <name> <path>
  if [ -f "$2" ]; then ok "$1"; else bad "$1 (missing: $2)"; fi
}

expect_no_file() { # expect_no_file <name> <path>
  if [ -e "$2" ]; then bad "$1 (exists: $2)"; else ok "$1"; fi
}

BASH_BIN="$(command -v bash)"

# The quick profile's phases in canonical order (mirrored from the profile
# functions of agent-verify.sh, used only for assertions).
EXPECTED_PHASES="repo: hygiene|frontend: typecheck|frontend: lint|backend: django check|backend: migration drift"
EXPECTED_COMMANDS='git diff HEAD --check|npm run typecheck|npm run lint|cd apps/api && uv run python manage.py check|cd apps/api && uv run python manage.py makemigrations --check --dry-run'

# make_fake_bin <dir> <npm-exit-code>
# Real symlinks for the tools agent-verify.sh itself uses; fake git/npm/uv
# for the phase commands (git and uv always exit 0, npm exits <code>).
make_fake_bin() {
  local dir="$1" npm_rc="$2" tool target
  mkdir -p "$dir"
  for tool in bash mktemp date dirname mv rm; do
    target="$(command -v "$tool" 2>/dev/null || true)"
    if [ -n "$target" ]; then ln -sf "$target" "$dir/$tool"; fi
  done
  printf '#!/bin/bash\nexit 0\n' >"$dir/git"
  printf '#!/bin/bash\nexit %s\n' "$npm_rc" >"$dir/npm"
  printf '#!/bin/bash\nexit 0\n' >"$dir/uv"
  chmod +x "$dir/git" "$dir/npm" "$dir/uv"
}

# plan_pairs_file <profile>
# Writes the profile's planned phases (name US command per line, US = 0x1f)
# to MATRIX_DIR/<profile>.plan, derived from the script's own read-only
# plan output. The plan output is the comparison source; this test file
# deliberately holds no second profile definition.
plan_pairs_file() {
  local prof="$1" out="$MATRIX_DIR/$1.plan"
  "$BASH_BIN" "$VERIFY" plan "$prof" 2>/dev/null | awk '
    /^[ ]*[0-9]+[ ]+/ && / mutates: / {
      line = $0
      sub(/^[ ]*[0-9]+[ ]+/, "", line)
      idx = index(line, " mutates: ")
      name = substr(line, 1, idx - 1)
      sub(/[ ]+$/, "", name)
      pending = name
      next
    }
    pending != "" && /^ +\$ / {
      cmd = substr($0, index($0, "$ ") + 2)
      printf "%s\037%s\n", pending, cmd
      pending = ""
    }
  ' >"$out"
  printf '%s' "$out"
}

# validate_matrix <file> <profile> <plan-pairs-file> <result> <top-exit-code>
# <failed-index|-1>
# Prints schema/plan-consistency violations (exit 1) or nothing (exit 0).
# Phases must appear exactly once, in plan order, with the plan commands.
validate_matrix() {
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    const profile = process.argv[2];
    const planFile = process.argv[3];
    const result = process.argv[4];
    const topRc = parseInt(process.argv[5], 10);
    const failedIdx = parseInt(process.argv[6], 10);
    const errs = [];
    const eq = (a, b, m) => { if (a !== b) errs.push(m + ": " + JSON.stringify(a) + " != " + JSON.stringify(b)); };
    const isNum = (x) => typeof x === "number" && Number.isFinite(x);
    let d;
    try { d = JSON.parse(fs.readFileSync(f, "utf8")); }
    catch (e) { console.log("invalid JSON: " + e.message); process.exit(1); }
    const pairs = fs.readFileSync(planFile, "utf8").split("\n").filter((l) => l.length > 0)
      .map((l) => { const i = l.indexOf("\u001f"); return [l.slice(0, i), l.slice(i + 1)]; });
    if (pairs.length === 0) { console.log("plan pairs file is empty"); process.exit(1); }
    eq(Object.keys(d).join("|"), "schemaVersion|profile|mode|agentRunId|result|exitCode|startedAt|finishedAt|durationMs|phases", "top-level key order");
    eq(d.schemaVersion, 1, "schemaVersion");
    eq(d.profile, profile, "profile");
    eq(d.mode, "run", "mode");
    eq(d.result, result, "result");
    eq(d.exitCode, topRc, "exitCode (top-level == process)");
    const ts = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
    if (!ts.test(d.startedAt || "")) errs.push("startedAt format");
    if (!ts.test(d.finishedAt || "")) errs.push("finishedAt format");
    if (!isNum(d.durationMs) || d.durationMs < 0) errs.push("durationMs");
    if (!Array.isArray(d.phases)) {
      errs.push("phases not an array");
    } else {
      eq(d.phases.length, pairs.length, "phases.length == plan phase count");
      d.phases.forEach((p, i) => {
        eq(Object.keys(p).join("|"), "name|command|outcome|exitCode|durationMs", "phases[" + i + "] key order");
        if (!pairs[i]) { errs.push("phases[" + i + "] has no plan counterpart"); return; }
        eq(p.name, pairs[i][0], "phases[" + i + "].name (plan order)");
        eq(p.command, pairs[i][1], "phases[" + i + "].command (plan order)");
        const want = result === "pass" ? "passed"
          : i === failedIdx ? "failed"
          : i < failedIdx ? "passed"
          : "not_run";
        eq(p.outcome, want, "phases[" + i + "].outcome");
        if (p.outcome === "not_run") {
          if (p.exitCode !== null) errs.push("phases[" + i + "].exitCode must be null");
        } else if (!isNum(p.exitCode)) {
          errs.push("phases[" + i + "].exitCode must be a number");
        } else if (p.outcome === "failed" && p.exitCode !== topRc) {
          errs.push("phases[" + i + "].exitCode != top-level");
        } else if (p.outcome === "passed" && p.exitCode !== 0) {
          errs.push("phases[" + i + "].exitCode must be 0");
        }
        if (!isNum(p.durationMs)) errs.push("phases[" + i + "].durationMs must be a number");
      });
    }
    if (errs.length) { console.log(errs.join("\n")); process.exit(1); }
  ' "$1" "$2" "$3" "$4" "$5" "$6"
}

# run_matrix_validate <name> <file> <profile> <plan-file> <result> <rc> <failedIdx>
# Same contract as validate_matrix, but tolerant under set -e: failures are
# reported through expect_rc (with the validator output printed), not by
# aborting the suite.
run_matrix_validate() {
  local name="$1" file="$2" prof="$3" pf="$4" result="$5" rc="$6" fidx="$7"
  local vout vrc=0
  set +e
  vout="$(validate_matrix "$file" "$prof" "$pf" "$result" "$rc" "$fidx" 2>&1)" || vrc=$?
  set -e
  expect_rc "$name" 0 "$vrc"
  if [ -n "$vout" ]; then printf '%s\n' "$vout"; fi
}

# validate_summary <file> <result> <top-exit-code> <failed-index|-1>
# Prints schema violations (exit 1) or nothing (exit 0).
validate_summary() {
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    const result = process.argv[2];
    const topRc = parseInt(process.argv[3], 10);
    const failedIdx = parseInt(process.argv[4], 10);
    const PHASES = process.argv[5].split("|");
    const CMDS = process.argv[6].split("|");
    const errs = [];
    const eq = (a, b, m) => { if (a !== b) errs.push(m + ": " + JSON.stringify(a) + " != " + JSON.stringify(b)); };
    const isNum = (x) => typeof x === "number" && Number.isFinite(x);
    let d;
    try { d = JSON.parse(fs.readFileSync(f, "utf8")); }
    catch (e) { console.log("invalid JSON: " + e.message); process.exit(1); }
    eq(Object.keys(d).join("|"), "schemaVersion|profile|mode|agentRunId|result|exitCode|startedAt|finishedAt|durationMs|phases", "top-level key order");
    eq(d.schemaVersion, 1, "schemaVersion");
    eq(d.profile, "quick", "profile");
    eq(d.mode, "run", "mode");
    eq(d.result, result, "result");
    eq(d.exitCode, topRc, "exitCode (top-level == process)");
    const ts = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
    if (!ts.test(d.startedAt || "")) errs.push("startedAt format");
    if (!ts.test(d.finishedAt || "")) errs.push("finishedAt format");
    if (!isNum(d.durationMs) || d.durationMs < 0) errs.push("durationMs");
    if (!Array.isArray(d.phases)) {
      errs.push("phases not an array");
    } else {
      eq(d.phases.length, PHASES.length, "phases.length");
      d.phases.forEach((p, i) => {
        eq(Object.keys(p).join("|"), "name|command|outcome|exitCode|durationMs", "phases[" + i + "] key order");
        eq(p.name, PHASES[i], "phases[" + i + "].name (stable order)");
        eq(p.command, CMDS[i], "phases[" + i + "].command (announced command)");
        const want = result === "pass" ? "passed"
          : i === failedIdx ? "failed"
          : i < failedIdx ? "passed"
          : "not_run";
        eq(p.outcome, want, "phases[" + i + "].outcome");
        if (p.outcome === "not_run") {
          if (p.exitCode !== null) errs.push("phases[" + i + "].exitCode must be null");
        } else if (!isNum(p.exitCode)) {
          errs.push("phases[" + i + "].exitCode must be a number");
        } else if (p.outcome === "failed" && p.exitCode !== topRc) {
          errs.push("phases[" + i + "].exitCode != top-level");
        } else if (p.outcome === "passed" && p.exitCode !== 0) {
          errs.push("phases[" + i + "].exitCode must be 0");
        }
        if (!isNum(p.durationMs)) errs.push("phases[" + i + "].durationMs must be a number");
      });
    }
    if (errs.length) { console.log(errs.join("\n")); process.exit(1); }
  ' "$1" "$2" "$3" "$4" "$EXPECTED_PHASES" "$EXPECTED_COMMANDS"
}

# ------------------------------------------------------------ setup --------
TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT
SUMDIR="$TMPROOT/summaries"
mkdir -p "$SUMDIR"
FAKE_BIN_OK="$TMPROOT/bin-ok"
FAKE_BIN_FAIL="$TMPROOT/bin-fail"
make_fake_bin "$FAKE_BIN_OK" 0
make_fake_bin "$FAKE_BIN_FAIL" 7

MATRIX_DIR="$TMPROOT/matrix"
mkdir -p "$MATRIX_DIR"

# FAKE_BIN_MIDFAIL: uv fails only for `manage.py makemigrations` (the
# middle phase of the backend profile) with exit code 9.
FAKE_BIN_MIDFAIL="$TMPROOT/bin-midfail"
make_fake_bin "$FAKE_BIN_MIDFAIL" 0
cat > "$FAKE_BIN_MIDFAIL/uv" <<'UV_EOF'
#!/bin/bash
for a in "$@"; do
  case "$a" in
    makemigrations) exit 9 ;;
  esac
done
exit 0
UV_EOF
chmod +x "$FAKE_BIN_MIDFAIL/uv"

# ------------------------------------------------------------ t01 help -----
run_cmd "$BASH_BIN" "$VERIFY" --help
out="$CAP_OUT"; rc="$RC"
expect_rc "t01a --help exits 0" 0 "$rc"
expect_contains "t01b --help documents the flag" "$out" "--summary-json <path> <profile>"
expect_contains "t01c --help documents schemaVersion" "$out" "schemaVersion"
expect_contains "t01d --help documents not_run" "$out" "not_run"
expect_contains "t01e --help documents exit code 75" "$out" "75"
expect_contains "t01f --help documents no directory creation" "$out" "never creates directories"
expect_contains "t01g --help documents evidence-only boundary" "$out" "never claims RUNTIME_VERIFIED"
expect_contains "t01h --help documents FG_AGENT_RUN_ID correlation" "$out" "FG_AGENT_RUN_ID"

# ------------------------------------------------------- t02 usage errors --
run_cmd "$BASH_BIN" "$VERIFY" --summary-json
expect_rc "t02a --summary-json without path exits 2" 2 "$RC"
expect_contains "t02b error names the missing path" "$CAP_OUT" "requires a file path"
run_cmd "$BASH_BIN" "$VERIFY" --summary-json a.json --summary-json b.json quick
expect_rc "t02c doubled flag exits 2" 2 "$RC"
expect_contains "t02d error names the doubled flag" "$CAP_OUT" "may only be given once"

# --------------------------------------------- t03 simulated success --------
run_cmd env PATH="$FAKE_BIN_OK" MY_FAKE_SECRET=supersecretpassword123 "$BASH_BIN" "$VERIFY" --summary-json "$SUMDIR/ok.json" quick
expect_rc "t03a simulated success exits 0" 0 "$RC"
expect_file "t03b summary file created" "$SUMDIR/ok.json"
vout="$(validate_summary "$SUMDIR/ok.json" pass 0 -1 2>&1)"; vrc=$?
expect_rc "t03c pass summary schema valid (all passed)" 0 "$vrc"
[ -n "$vout" ] && printf '%s\n' "$vout"
expect_not_contains "t03d no secret value in summary" "$(cat "$SUMDIR/ok.json")" "supersecretpassword123"
expect_not_contains "t03e no env var names in summary" "$(cat "$SUMDIR/ok.json")" "MY_FAKE_SECRET"
expect_not_contains "t03f no RUNTIME_VERIFIED claim in summary" "$(cat "$SUMDIR/ok.json")" "RUNTIME_VERIFIED"
# FG_AGENT_RUN_ID: unset -> explicit null (no timestamp guessing anywhere)
node -e 'const d=require(process.argv[1]); process.exit(d.agentRunId===null?0:1)' "$SUMDIR/ok.json" \
  && ok "t03g agentRunId is null when FG_AGENT_RUN_ID is unset" \
  || bad "t03g agentRunId is null when FG_AGENT_RUN_ID is unset"
mkdir -p "$SUMDIR/runid"
run_cmd env PATH="$FAKE_BIN_OK" FG_AGENT_RUN_ID="run-test-123" "$BASH_BIN" "$VERIFY" --summary-json "$SUMDIR/runid/run.json" quick
expect_rc "t03h summary with FG_AGENT_RUN_ID exits 0" 0 "$RC"
node -e 'const d=require(process.argv[1]); process.exit(d.agentRunId==="run-test-123"?0:1)' "$SUMDIR/runid/run.json" \
  && ok "t03i explicit run id recorded as agentRunId" \
  || bad "t03i explicit run id recorded as agentRunId"
run_cmd env PATH="$FAKE_BIN_OK" FG_AGENT_RUN_ID="bad id!" "$BASH_BIN" "$VERIFY" --summary-json "$SUMDIR/runid/bad.json" quick
expect_rc "t03j invalid FG_AGENT_RUN_ID rejected before phases (exit 2)" 2 "$RC"
expect_no_file "t03k no summary created for invalid FG_AGENT_RUN_ID" "$SUMDIR/runid/bad.json"

# --------------------------------------- t04 no file without the flag ------
run_cmd env PATH="$FAKE_BIN_OK" "$BASH_BIN" "$VERIFY" quick
expect_rc "t04a plain run exits 0" 0 "$RC"
expect_no_file "t04b no JSON file without --summary-json" "$SUMDIR/none.json"

# --------------------------- t05 human output unchanged with the flag ------
norm() { printf '%s' "$1" | sed -E 's/[0-9]+s/<T>/g'; }
expect_eq "t05 human output identical with/without flag (timing normalized)" \
  "$(norm "$CAP_OUT")" \
  "$(norm "$(env PATH="$FAKE_BIN_OK" "$BASH_BIN" "$VERIFY" --summary-json "$SUMDIR/ok2.json" quick 2>&1)")"

# ------------------------------------------------- t06 simulated fail-fast -
run_cmd env PATH="$FAKE_BIN_FAIL" "$BASH_BIN" "$VERIFY" --summary-json "$SUMDIR/fail.json" quick
expect_rc "t06a fail-fast process exit code 7" 7 "$RC"
expect_contains "t06b fail-fast banner preserved" "$CAP_OUT" "profile=quick result=FAIL (phase exit code 7"
expect_file "t06c fail summary file created" "$SUMDIR/fail.json"
vout="$(validate_summary "$SUMDIR/fail.json" fail 7 1 2>&1)"; vrc=$?
expect_rc "t06d fail summary schema valid (one failed, later not_run)" 0 "$vrc"
[ -n "$vout" ] && printf '%s\n' "$vout"

# ------------------------------------------- t07 no leftover temp files ----
leftover="$(find "$SUMDIR" -name '.agent-verify-summary-*' | wc -l | tr -d ' ')"
expect_eq "t07a no leftover temporary files" "0" "$leftover"
json_count="$(find "$SUMDIR" -type f -name '*.json' | wc -l | tr -d ' ')"
expect_eq "t07b exactly the four expected summaries (incl. runid fixture)" "4" "$json_count"

# -------------------------------------- t08 invalid target directories -----
run_cmd env PATH="$FAKE_BIN_OK" "$BASH_BIN" "$VERIFY" --summary-json "$SUMDIR/no/such/dir/x.json" quick
expect_rc "t08a missing target directory exits 2" 2 "$RC"
expect_contains "t08b error names the missing directory" "$CAP_OUT" "does not exist"
expect_contains "t08c error says no directories are created" "$CAP_OUT" "never creates directories"
expect_no_file "t08d no parent directories created" "$SUMDIR/no"
expect_no_file "t08e no summary file created" "$SUMDIR/no/such/dir/x.json"
expect_not_contains "t08f no phase executed before rejection" "$CAP_OUT" "==> "

mkdir -p "$SUMDIR/adir"
run_cmd env PATH="$FAKE_BIN_OK" "$BASH_BIN" "$VERIFY" --summary-json "$SUMDIR/adir" quick
expect_rc "t08g target-is-directory exits 2" 2 "$RC"
expect_contains "t08h error says not a regular file" "$CAP_OUT" "not a regular file"

RODIR="$TMPROOT/ro"
mkdir -p "$RODIR"
chmod 555 "$RODIR"
run_cmd env PATH="$FAKE_BIN_OK" "$BASH_BIN" "$VERIFY" --summary-json "$RODIR/x.json" quick
rc_unwritable="$RC"
chmod 755 "$RODIR"
expect_rc "t08i unwritable target directory exits 2" 2 "$rc_unwritable"
expect_contains "t08j error mentions writability" "$CAP_OUT" "not writable"

# ------------------------------------------------------------ t09 plan -----
before_tree="$(git -C "$REPO_ROOT" status --porcelain)"
run_cmd "$BASH_BIN" "$VERIFY" plan quick
expect_rc "t09a plan quick exits 0" 0 "$RC"
expect_contains "t09b plan prints inspection header" "$CAP_OUT" "inspection only"
expect_contains "t09c plan prints execution order" "$CAP_OUT" "Execution order"
expect_contains "t09d plan lists first phase" "$CAP_OUT" "repo: hygiene"
after_tree="$(git -C "$REPO_ROOT" status --porcelain)"
expect_eq "t09e plan is read-only (working tree unchanged)" "$before_tree" "$after_tree"
expect_not_contains "t09f plan output never mentions a summary" "$CAP_OUT" "summary"

run_cmd "$BASH_BIN" "$VERIFY" --summary-json "$SUMDIR/plan.json" plan quick
expect_rc "t09g plan rejects --summary-json (exit 2)" 2 "$RC"
expect_contains "t09h rejection message names plan" "$CAP_OUT" "plan"
expect_no_file "t09i plan writes no summary file" "$SUMDIR/plan.json"

# -------------------------------------------- t10 relative target path -----
run_cmd bash -c 'cd "$1" && PATH="$2" exec "$3" "$4" --summary-json rel.json quick' \
  _ "$SUMDIR" "$FAKE_BIN_OK" "$BASH_BIN" "$VERIFY"
expect_rc "t10a relative-path run exits 0" 0 "$RC"
expect_file "t10b relative path resolves against caller CWD" "$SUMDIR/rel.json"

# ---------------------------------------- t11 script structural validity ---
run_cmd bash -n "$VERIFY"
expect_rc "t11a bash -n agent-verify.sh" 0 "$RC"

# ------------------------- t12 profile matrix (simulated success) ---------
# One simulated successful summary run per executable profile. The expected
# phase list (names, commands, order) is derived from the script's own
# read-only plan output via plan_pairs_file — no second profile definition.
for prof in quick frontend backend core; do
  run_cmd env PATH="$FAKE_BIN_OK" "$BASH_BIN" "$VERIFY" --summary-json "$MATRIX_DIR/$prof.json" "$prof"
  expect_rc "t12 $prof: simulated run exits 0" 0 "$RC"
  pf="$(plan_pairs_file "$prof")"
  run_matrix_validate "t12 $prof: summary valid, plan-consistent, all phases passed" \
    "$MATRIX_DIR/$prof.json" "$prof" "$pf" pass 0 -1
done
for prof in e2e full; do
  # Reset opt-in set exclusively for this simulated shim run; the npm shim
  # executes, no browser launches, no database is touched.
  run_cmd env PATH="$FAKE_BIN_OK" FG_ALLOW_E2E_RESET=1 "$BASH_BIN" "$VERIFY" --summary-json "$MATRIX_DIR/$prof.json" "$prof"
  expect_rc "t12 $prof: simulated run (opt-in) exits 0" 0 "$RC"
  expect_contains "t12 $prof: consent acknowledged" "$CAP_OUT" "FG_ALLOW_E2E_RESET=1 acknowledged"
  pf="$(plan_pairs_file "$prof")"
  run_matrix_validate "t12 $prof: summary valid, plan-consistent, all phases passed" \
    "$MATRIX_DIR/$prof.json" "$prof" "$pf" pass 0 -1
done

# --------------------- t13 multi-phase fail-fast (backend, mid phase) -----
run_cmd env PATH="$FAKE_BIN_MIDFAIL" "$BASH_BIN" "$VERIFY" --summary-json "$MATRIX_DIR/backend-fail.json" backend
expect_rc "t13a backend fail-fast process exit code 9" 9 "$RC"
expect_contains "t13b fail-fast banner preserved" "$CAP_OUT" "profile=backend result=FAIL (phase exit code 9"
pf="$(plan_pairs_file backend)"
run_matrix_validate "t13c backend fail summary: passed -> failed -> not_run, codes consistent" \
  "$MATRIX_DIR/backend-fail.json" backend "$pf" fail 9 1

# ---------------------- t14 playwright args in the announced command ------
PW_JSON="$MATRIX_DIR/e2e-pw.json"
run_cmd env PATH="$FAKE_BIN_OK" FG_ALLOW_E2E_RESET=1 MY_FAKE_SECRET=supersecretpassword123 \
  "$BASH_BIN" "$VERIFY" --summary-json "$PW_JSON" e2e -- --grep 'say "hi" & bye' --project=chrome
expect_rc "t14a e2e with playwright args exits 0" 0 "$RC"
announced="$(printf '%s\n' "$CAP_OUT" | awk '/^\$ /{c=substr($0, 3)} END{print c}')"
expect_contains "t14b announced command carries the grep arg" "$announced" 'say "hi" & bye'
expect_contains "t14c announced command carries --project" "$announced" "--project=chrome"
vrc=0
set +e
vout="$(node -e '
  const fs = require("fs");
  const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const errs = [];
  const p = (d.phases || []).find((x) => x.name === "e2e: playwright");
  if (!p) { console.log("e2e phase missing"); process.exit(1); }
  if (p.command !== process.argv[2]) errs.push("summary command != announced command");
  if (p.outcome !== "passed") errs.push("outcome=" + p.outcome);
  if (d.exitCode !== 0 || d.result !== "pass") errs.push("top-level result/exitCode");
  if (errs.length) { console.log(errs.join("\n")); process.exit(1); }
' "$PW_JSON" "$announced" 2>&1)" || vrc=$?
set -e
expect_rc "t14d summary command identical to announced command (JSON-parsed)" 0 "$vrc"
if [ -n "$vout" ]; then printf '%s\n' "$vout"; fi
raw="$(cat "$PW_JSON")"
expect_contains "t14e quotes JSON-escaped in the raw file" "$raw" 'say \"hi\"'
expect_not_contains "t14f raw file has no unescaped quote pair" "$raw" 'say "hi"'
expect_not_contains "t14g no secret value in the playwright-args summary" "$raw" "supersecretpassword123"

PW_JSON2="$MATRIX_DIR/full-pw.json"
run_cmd env PATH="$FAKE_BIN_OK" FG_ALLOW_E2E_RESET=1 MY_FAKE_SECRET=supersecretpassword123 \
  "$BASH_BIN" "$VERIFY" --summary-json "$PW_JSON2" full -- --project=chrome
expect_rc "t14h full with playwright args exits 0" 0 "$RC"
announced2="$(printf '%s\n' "$CAP_OUT" | awk '/^\$ /{c=substr($0, 3)} END{print c}')"
expect_contains "t14i full announced command carries the args" "$announced2" "--project=chrome"
vrc=0
set +e
vout="$(node -e '
  const fs = require("fs");
  const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const errs = [];
  const p = (d.phases || []).find((x) => x.name === "e2e: playwright");
  if (!p) { console.log("e2e phase missing"); process.exit(1); }
  if (p.command !== process.argv[2]) errs.push("summary command != announced command");
  if (p.outcome !== "passed") errs.push("outcome=" + p.outcome);
  if (d.exitCode !== 0 || d.result !== "pass") errs.push("top-level result/exitCode");
  if (errs.length) { console.log(errs.join("\n")); process.exit(1); }
' "$PW_JSON2" "$announced2" 2>&1)" || vrc=$?
set -e
expect_rc "t14j full summary command identical to announced command (JSON-parsed)" 0 "$vrc"
if [ -n "$vout" ]; then printf '%s\n' "$vout"; fi
expect_not_contains "t14k no secret value in the full summary" "$(cat "$PW_JSON2")" "supersecretpassword123"

# ------------------------------------------------------------- summary -----
printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf 'agent-verify tests: PASS (%d checks)\n' "$PASS"
  exit 0
fi
printf 'agent-verify tests: FAIL (%d failed, %d passed)\n' "$FAIL" "$PASS"
printf 'failed: %s\n' "${FAILED[*]}"
exit 1
