#!/usr/bin/env bash
#
# Tests for deploy/scripts/postgres-backup.sh and
# deploy/scripts/postgres-restore-empty.sh.
#
# Run:  bash scripts/tests/postgres-backup-restore.test.sh
#
# Requires: bash, sed, awk, cmp, mktemp, and a host SHA-256 facility
# (sha256sum or shasum). No Docker daemon is needed: the `docker` and
# `docker-compose` CLIs are replaced by deterministic PATH shims that
# emulate the exact Compose surface the scripts use (compose version;
# exec -T db sh -c 'exit 0' / pg_isready / pg_dump / pg_restore / psql /
# rm -f), with scripted behavior controlled by FAKE_* environment
# variables and an invocation log. The scripts themselves run unmodified.
#
# Coverage:
#   backup:  missing --env-file / --output-dir; nonexistent env file;
#            output dir inside the repository; no Compose CLI; db not
#            usable; pg_dump failure; empty dump; invalid archive
#            (pg_restore --list rejects); success path (naming, 0600
#            permissions, sha256 sidecar content + self-consistency, no
#            .partial left, tool invocations observed)
#   restore: missing --archive; nonexistent archive (no docker calls);
#            missing checksum sidecar (no docker calls); checksum
#            mismatch (no docker calls); sidecar naming a different
#            archive (no docker calls); invalid archive (no restore);
#            non-empty target refusal (no restore, refusal message);
#            success path (--exit-on-error present, no --clean/--create/
#            --no-owner, correct dbname/username, staging cleaned up,
#            post-restore check executed)

set -Eeuo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKUP="$REPO_ROOT/deploy/scripts/postgres-backup.sh"
RESTORE="$REPO_ROOT/deploy/scripts/postgres-restore-empty.sh"

PASS=0
FAIL=0
FAILED=()

ok()   { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); FAILED+=("$1"); printf 'FAIL %s\n' "$1"; }

CAP_OUT=""
RC=0
run_cmd() {
  RC=0
  set +e
  CAP_OUT="$("$@" 2>&1)" || RC=$?
  set -e
}

expect_rc()         { if [ "$2" -eq "$3" ]; then ok "$1"; else bad "$1 (expected rc=$2, got rc=$3)"; fi; }
expect_rc_nonzero() { if [ "$2" -ne 0 ]; then ok "$1"; else bad "$1 (expected non-zero rc, got 0)"; fi; }
expect_contains()   { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 (missing: $3)" ;; esac; }
expect_not_contains() { case "$2" in *"$3"*) bad "$1 (unexpected: $3)" ;; *) ok "$1" ;; esac; }
expect_eq()         { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

host_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

file_mode() {
  if stat -c %a /dev/null >/dev/null 2>&1; then stat -c %a "$1"
  else stat -f %Lp "$1"; fi
}

# --- Sanity -----------------------------------------------------------------
[ -x "$BACKUP" ]  || { echo "FATAL: $BACKUP missing or not executable"; exit 1; }
[ -x "$RESTORE" ] || { echo "FATAL: $RESTORE missing or not executable"; exit 1; }

# --- Test workspace -----------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fg-backup-restore-tests.XXXXXX")"
cleanup_work() { rm -rf -- "$WORK"; }
trap cleanup_work EXIT

SHIM_DIR="$WORK/shim"
STATE="$WORK/fake-state"
ENV_FILE="$WORK/production.env"
OUT_DIR="$WORK/backups"
VALID_ARCHIVE="$WORK/valid-archive.bin"
mkdir -p "$SHIM_DIR" "$OUT_DIR"

# Deterministic fake custom-format archive bytes.
printf 'PGDMP\nfake custom archive bytes for tests\n' > "$VALID_ARCHIVE"

# env fixture (synthetic values only; the scripts read only POSTGRES_DB /
# POSTGRES_USER and the shim does not interpret any of them).
cat > "$ENV_FILE" <<'ENVEOF'
FG_WEB_IMAGE=fg-workspace-web:test
FG_API_IMAGE=fg-workspace-api:test
FG_POSTGRES_DATA_VOLUME=fg_test_pg16_data
POSTGRES_DB=accdb
POSTGRES_USER=accuser
POSTGRES_PASSWORD=accpass-not-printed
DJANGO_SECRET_KEY=not-a-real-secret
DJANGO_ALLOWED_HOSTS=127.0.0.1
DJANGO_CSRF_TRUSTED_ORIGINS=https://127.0.0.1:8080
ENVEOF

# --- docker / docker-compose shim ----------------------------------------------
cat > "$SHIM_DIR/docker" <<'SHIMEOF'
#!/usr/bin/env bash
# Deterministic docker CLI shim (postgres-backup-restore tests).
set -u
: "${FAKE_STATE_DIR:?FAKE_STATE_DIR not set}"
STATE="${FAKE_STATE_DIR}"
LOG="$STATE/exec-log"
: "${FAKE_COMPOSE_OK:=1}"
: "${FAKE_EXEC_OK:=1}"
: "${FAKE_PG_READY:=1}"
: "${FAKE_DUMP_RC:=0}"
: "${FAKE_DUMP_FILE:=}"
: "${FAKE_VALID_ARCHIVE_FILE:=}"
: "${FAKE_DB_EMPTY:=1}"
: "${FAKE_RESTORE_RC:=0}"

echo "docker $*" >> "$LOG"

case "$(basename "$0")" in
  docker-compose) set -- compose "$@" ;;
esac

[ "${1:-}" = "compose" ] || exit 0
[ "${2:-}" = "version" ] && {
  if [ "$FAKE_COMPOSE_OK" = "1" ]; then echo "Docker Compose version fake"; exit 0; fi
  exit 1
}

# collect the args following 'exec'
rest=()
in_exec=0
for a in "$@"; do
  if [ "$in_exec" = "1" ]; then rest+=("$a"); fi
  if [ "$a" = "exec" ]; then in_exec=1; fi
done
[ "${rest[0]:-}" = "-T" ] || exit 0
[ "${rest[1]:-}" = "db" ] || exit 0
rest=("${rest[@]:2}")
[ ${#rest[@]} -gt 0 ] || exit 0
first="${rest[0]}"

case "$first" in
  sh)
    sc="${rest[2]:-}"
    case "$sc" in
      "exit 0")
        if [ "$FAKE_EXEC_OK" = "1" ]; then exit 0; fi
        echo "container is not running" >&2
        exit 1
        ;;
      "cat"*)
        tgt="${sc#*> }"
        tgt="${tgt%?}"   # drop the trailing quote
        cat > "$STATE/staged${tgt##*/}"
        exit 0
        ;;
      *) exit 0 ;;
    esac
    ;;
  pg_isready)
    if [ "$FAKE_PG_READY" = "1" ]; then exit 0; fi
    echo "pg_isready: could not connect" >&2
    exit 2
    ;;
  pg_dump)
    if [ "$FAKE_DUMP_RC" != "0" ]; then
      echo "pg_dump: fake failure" >&2
      exit "$FAKE_DUMP_RC"
    fi
    if [ -n "$FAKE_DUMP_FILE" ] && [ -f "$FAKE_DUMP_FILE" ]; then
      cat "$FAKE_DUMP_FILE"
    fi
    exit 0
    ;;
  pg_restore)
    if [ "${rest[1]:-}" = "--list" ]; then
      f="${rest[2]:-}"
      staged="$STATE/staged${f##*/}"
      if [ -n "$FAKE_VALID_ARCHIVE_FILE" ] && [ -f "$FAKE_VALID_ARCHIVE_FILE" ] && [ -f "$staged" ]; then
        if cmp -s "$staged" "$FAKE_VALID_ARCHIVE_FILE"; then
          echo ";(fake toc)"
          exit 0
        fi
      fi
      echo "pg_restore: invalid archive" >&2
      exit 1
    fi
    printf '%s\n' "${rest[@]}" > "$STATE/restore-args"
    if [ "$FAKE_RESTORE_RC" = "0" ]; then echo 1 > "$STATE/restore-applied"; fi
    exit "$FAKE_RESTORE_RC"
    ;;
  psql)
    sql=""
    prev=""
    for a in "${rest[@]}"; do
      if [ "$prev" = "-tAc" ]; then sql="$a"; fi
      prev="$a"
    done
    case "$sql" in
      *pg_class*)
        if [ -f "$STATE/restore-applied" ]; then
          echo "7|0"
        elif [ "$FAKE_DB_EMPTY" = "1" ]; then
          echo "0|0"
        else
          echo "3|1"
        fi
        ;;
      *) echo "0|0" ;;
    esac
    exit 0
    ;;
  rm)
    for a in "${rest[@]}"; do
      case "$a" in
        /tmp/*) rm -f "$STATE/staged${a##*/}" ;;
      esac
    done
    exit 0
    ;;
  *) exit 0 ;;
esac
exit 0
SHIMEOF
chmod 755 "$SHIM_DIR/docker"
cp "$SHIM_DIR/docker" "$SHIM_DIR/docker-compose"

reset_state() {
  rm -rf -- "$STATE"
  mkdir -p "$STATE"
}

# run_script <script> <args...> with the shim PATH and per-case FAKE_* env
run_script() {
  local script="$1"; shift
  RC=0
  set +e
  CAP_OUT="$(FAKE_STATE_DIR="$STATE" PATH="$SHIM_DIR:$PATH" "$script" "$@" 2>&1)" || RC=$?
  set -e
}

exec_log_lines() {
  if [ -f "$STATE/exec-log" ]; then cat "$STATE/exec-log"; fi
}

# =============================================================================
# BACKUP script cases
# =============================================================================

# B1: missing --env-file
reset_state
run_script "$BACKUP" --output-dir "$OUT_DIR"
expect_rc_nonzero "backup: missing --env-file rejected" "$RC"
expect_contains "backup: missing --env-file shows usage" "$CAP_OUT" "Usage:"

# B2: missing --output-dir
reset_state
run_script "$BACKUP" --env-file "$ENV_FILE"
expect_rc_nonzero "backup: missing --output-dir rejected" "$RC"

# B3: nonexistent env file
reset_state
run_script "$BACKUP" --env-file "$WORK/does-not-exist.env" --output-dir "$OUT_DIR"
expect_rc_nonzero "backup: nonexistent env file rejected" "$RC"
expect_contains "backup: nonexistent env file message" "$CAP_OUT" "env file not found"

# B4: output dir inside the repository (refused)
reset_state
run_script "$BACKUP" --env-file "$ENV_FILE" --output-dir "$REPO_ROOT/deploy"
expect_rc_nonzero "backup: output dir inside repository refused" "$RC"
expect_contains "backup: inside-repo refusal message" "$CAP_OUT" "repository"

# B5: no usable Compose CLI
reset_state
FAKE_COMPOSE_OK=0 run_script "$BACKUP" --env-file "$ENV_FILE" --output-dir "$OUT_DIR"
expect_rc_nonzero "backup: no Compose CLI fails" "$RC"
expect_contains "backup: no Compose CLI message" "$CAP_OUT" "Compose CLI"
ls "$OUT_DIR" | grep -q . && bad "backup: no Compose CLI left artifacts" || ok "backup: no Compose CLI left no artifacts"

# B6: db container not usable
reset_state
FAKE_EXEC_OK=0 run_script "$BACKUP" --env-file "$ENV_FILE" --output-dir "$OUT_DIR"
expect_rc_nonzero "backup: db not usable fails" "$RC"
expect_contains "backup: db not usable message" "$CAP_OUT" "db service is not usable"
ls "$OUT_DIR" | grep -q . && bad "backup: db-not-usable left artifacts" || ok "backup: db-not-usable left no artifacts"

# B7: pg_dump fails -> partial removed, no final artifact
reset_state
FAKE_DUMP_RC=1 run_script "$BACKUP" --env-file "$ENV_FILE" --output-dir "$OUT_DIR"
expect_rc_nonzero "backup: pg_dump failure fails the run" "$RC"
ls "$OUT_DIR" | grep -q . && bad "backup: pg_dump failure left artifacts" || ok "backup: pg_dump failure removed partial, left nothing"
expect_contains "backup: partial cleanup logged" "$CAP_OUT" "removed partial artifact"

# B8: empty dump -> rejected
reset_state
: > "$WORK/empty.dump"
FAKE_DUMP_FILE="$WORK/empty.dump" run_script "$BACKUP" --env-file "$ENV_FILE" --output-dir "$OUT_DIR"
expect_rc_nonzero "backup: empty dump rejected" "$RC"
expect_contains "backup: empty dump message" "$CAP_OUT" "empty archive"
ls "$OUT_DIR" | grep -q . && bad "backup: empty dump left artifacts" || ok "backup: empty dump left nothing"

# B9: invalid archive (pg_restore --list rejects) -> no publication
reset_state
printf 'this is not a pg_dump archive\n' > "$WORK/junk.dump"
FAKE_DUMP_FILE="$WORK/junk.dump" run_script "$BACKUP" --env-file "$ENV_FILE" --output-dir "$OUT_DIR"
expect_rc_nonzero "backup: invalid archive rejected" "$RC"
expect_contains "backup: invalid archive message" "$CAP_OUT" "pg_restore --list rejected"
ls "$OUT_DIR" | grep -q . && bad "backup: invalid archive left artifacts" || ok "backup: invalid archive left nothing"

# B10: success path
reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" \
  run_script "$BACKUP" --env-file "$ENV_FILE" --output-dir "$OUT_DIR"
expect_rc "backup: success exits 0" 0 "$RC"
DUMPS=("$OUT_DIR"/fg-workspace-accdb-*.dump)
[ ${#DUMPS[@]} -eq 1 ] && ok "backup: exactly one archive published" || bad "backup: expected exactly one archive (got ${#DUMPS[@]})"
FINAL="${DUMPS[0]}"
BASE="$(basename "$FINAL")"
case "$BASE" in
  fg-workspace-accdb-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.dump)
    ok "backup: artifact naming contract" ;;
  *) bad "backup: artifact naming contract (got $BASE)" ;;
esac
expect_eq "backup: archive permissions 0600" "$(file_mode "$FINAL")" "600"
expect_eq "backup: archive content matches dump" "$(host_sha256 "$FINAL")" "$(host_sha256 "$VALID_ARCHIVE")"
[ -f "$FINAL.sha256" ] && ok "backup: sha256 sidecar exists" || bad "backup: sha256 sidecar missing"
expect_eq "backup: sidecar permissions 0600" "$(file_mode "$FINAL.sha256")" "600"
SIDE_HASH="$(awk '{print $1}' "$FINAL.sha256")"
SIDE_NAME="$(awk '{print $2}' "$FINAL.sha256")"
expect_eq "backup: sidecar hash correct" "$SIDE_HASH" "$(host_sha256 "$FINAL")"
expect_eq "backup: sidecar names the archive" "$SIDE_NAME" "$BASE"
ls "$OUT_DIR" | grep -q '\.partial$' && bad "backup: .partial left behind" || ok "backup: no .partial remains"
LOG="$(exec_log_lines)"
expect_contains "backup: pg_dump -Fc invoked as the app role" "$LOG" "pg_dump -Fc -U accuser -d accdb"
expect_contains "backup: pg_restore --list validation invoked" "$LOG" "pg_restore --list /tmp/fg-backup-validate-"
expect_contains "backup: staging cleaned up" "$LOG" "rm -f -- /tmp/fg-backup-validate-"
expect_not_contains "backup: password never echoed" "$CAP_OUT" "accpass-not-printed"

# B11: --project-name is forwarded to compose
reset_state
mkdir -p "$WORK/backups2"
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" \
  run_script "$BACKUP" --env-file "$ENV_FILE" --output-dir "$WORK/backups2" --project-name accproj
expect_rc "backup: --project-name success exits 0" 0 "$RC"
expect_contains "backup: --project-name passed to compose" "$(exec_log_lines)" "--project-name accproj"

# =============================================================================
# RESTORE script cases
# =============================================================================

# helper: build a valid archive + matching sidecar in a dir
prepare_valid_archive() { # <dir> <name>
  cp "$VALID_ARCHIVE" "$1/$2"
  printf '%s  %s\n' "$(host_sha256 "$1/$2")" "$2" > "$1/$2.sha256"
}

# R1: missing --archive
reset_state
run_script "$RESTORE" --env-file "$ENV_FILE"
expect_rc_nonzero "restore: missing --archive rejected" "$RC"
expect_contains "restore: missing --archive shows usage" "$CAP_OUT" "Usage:"

# R2: nonexistent archive -> fails before ANY docker interaction
reset_state
run_script "$RESTORE" --env-file "$ENV_FILE" --archive "$WORK/nope.dump"
expect_rc_nonzero "restore: nonexistent archive rejected" "$RC"
expect_contains "restore: nonexistent archive message" "$CAP_OUT" "archive not found"
expect_eq "restore: nonexistent archive made no docker calls" "$(exec_log_lines | wc -l | tr -d ' ')" "0"

# R3: missing checksum sidecar -> fail closed, no docker calls
reset_state
mkdir -p "$WORK/r3"
cp "$VALID_ARCHIVE" "$WORK/r3/acc.dump"
run_script "$RESTORE" --env-file "$ENV_FILE" --archive "$WORK/r3/acc.dump"
expect_rc_nonzero "restore: missing checksum sidecar refused" "$RC"
expect_contains "restore: missing checksum message" "$CAP_OUT" "checksum sidecar not found"
expect_eq "restore: missing checksum made no docker calls" "$(exec_log_lines | wc -l | tr -d ' ')" "0"

# R4: checksum mismatch -> fail closed, no docker calls
reset_state
mkdir -p "$WORK/r4"
cp "$VALID_ARCHIVE" "$WORK/r4/acc.dump"
printf '0000000000000000000000000000000000000000000000000000000000000000  acc.dump\n' > "$WORK/r4/acc.dump.sha256"
run_script "$RESTORE" --env-file "$ENV_FILE" --archive "$WORK/r4/acc.dump"
expect_rc_nonzero "restore: checksum mismatch refused" "$RC"
expect_contains "restore: mismatch message" "$CAP_OUT" "MISMATCH"
expect_eq "restore: checksum mismatch made no docker calls" "$(exec_log_lines | wc -l | tr -d ' ')" "0"

# R5: sidecar naming a different archive -> refused, no docker calls
reset_state
mkdir -p "$WORK/r5"
cp "$VALID_ARCHIVE" "$WORK/r5/acc.dump"
cp "$VALID_ARCHIVE" "$WORK/r5/other.dump"
printf '%s  other.dump\n' "$(host_sha256 "$WORK/r5/other.dump")" > "$WORK/r5/acc.dump.sha256"
run_script "$RESTORE" --env-file "$ENV_FILE" --archive "$WORK/r5/acc.dump"
expect_rc_nonzero "restore: sidecar naming another archive refused" "$RC"
expect_contains "restore: wrong-name message" "$CAP_OUT" "identifies 'other.dump'"
expect_eq "restore: wrong-name sidecar made no docker calls" "$(exec_log_lines | wc -l | tr -d ' ')" "0"

# R6: invalid archive (parse fails) -> no restore, no database writes
reset_state
mkdir -p "$WORK/r6"
cp "$WORK/junk.dump" "$WORK/r6/acc.dump"
printf '%s  acc.dump\n' "$(host_sha256 "$WORK/r6/acc.dump")" > "$WORK/r6/acc.dump.sha256"
FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" run_script "$RESTORE" --env-file "$ENV_FILE" --archive "$WORK/r6/acc.dump"
expect_rc_nonzero "restore: invalid archive refused" "$RC"
expect_contains "restore: invalid archive message" "$CAP_OUT" "pg_restore --list rejected"
[ -f "$STATE/restore-args" ] && bad "restore: invalid archive still invoked pg_restore" || ok "restore: invalid archive invoked no pg_restore"

# R7: non-empty target -> hard refusal, zero changes
reset_state
mkdir -p "$WORK/r7"
prepare_valid_archive "$WORK/r7" "acc.dump"
FAKE_DB_EMPTY=0 FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" run_script "$RESTORE" --env-file "$ENV_FILE" --archive "$WORK/r7/acc.dump"
expect_rc_nonzero "restore: non-empty target refused" "$RC"
expect_contains "restore: refusal message" "$CAP_OUT" "NOT empty"
expect_contains "restore: refusal states no changes" "$CAP_OUT" "No changes were made"
[ -f "$STATE/restore-args" ] && bad "restore: non-empty target still invoked pg_restore" || ok "restore: non-empty target invoked no pg_restore"
LOG="$(exec_log_lines)"
expect_contains "restore: emptiness query executed" "$LOG" "psql"
expect_contains "restore: db reached for the check only" "$LOG" "pg_isready"

# R8: success path (empty target, valid checksum + archive)
reset_state
mkdir -p "$WORK/r8"
prepare_valid_archive "$WORK/r8" "acc.dump"
FAKE_DB_EMPTY=1 FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_RESTORE_RC=0 run_script "$RESTORE" --env-file "$ENV_FILE" --archive "$WORK/r8/acc.dump"
expect_rc "restore: success exits 0" 0 "$RC"
[ -f "$STATE/restore-applied" ] && ok "restore: pg_restore executed" || bad "restore: pg_restore not executed"
[ -f "$STATE/restore-args" ] || { bad "restore: restore-args missing"; : > "$STATE/restore-args"; }
RARGS="$(cat "$STATE/restore-args")"
expect_contains "restore: --exit-on-error required" "$RARGS" "--exit-on-error"
expect_contains "restore: --dbname=accdb" "$RARGS" "--dbname=accdb"
expect_contains "restore: --username=accuser" "$RARGS" "--username=accuser"
expect_not_contains "restore: no --clean" "$RARGS" "--clean"
expect_not_contains "restore: no --create" "$RARGS" "--create"
expect_not_contains "restore: no --no-owner" "$RARGS" "--no-owner"
expect_not_contains "restore: no --no-acl" "$RARGS" "--no-acl"
LOG="$(exec_log_lines)"
expect_contains "restore: staging cleaned up" "$LOG" "rm -f -- /tmp/fg-restore-"
PSQL_CALLS="$(printf '%s\n' "$LOG" | grep -c 'psql' || true)"
[ "$PSQL_CALLS" -ge 2 ] && ok "restore: pre- and post-restore checks executed" || bad "restore: expected >=2 psql calls, got $PSQL_CALLS"
expect_contains "restore: post-restore evidence reported" "$CAP_OUT" "user-schema relation(s) present"
expect_not_contains "restore: password never echoed" "$CAP_OUT" "accpass-not-printed"

# R9: --project-name is forwarded to compose
reset_state
mkdir -p "$WORK/r9"
prepare_valid_archive "$WORK/r9" "acc.dump"
FAKE_DB_EMPTY=1 FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_RESTORE_RC=0 \
  run_script "$RESTORE" --env-file "$ENV_FILE" --archive "$WORK/r9/acc.dump" --project-name accproj
expect_rc "restore: --project-name success exits 0" 0 "$RC"
expect_contains "restore: --project-name passed to compose" "$(exec_log_lines)" "--project-name accproj"

# --- Summary --------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  for t in ${FAILED[@]+"${FAILED[@]}"}; do printf '  failed: %s\n' "$t"; done
  exit 1
fi
exit 0
