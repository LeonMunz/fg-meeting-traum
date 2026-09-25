#!/usr/bin/env bash
#
# Tests for deploy/scripts/release.sh (manual exact-SHA release
# transaction).
#
# Run:  bash scripts/tests/release-transaction.test.sh
#
# Requires: bash, sed, grep, cmp, mktemp. No Docker daemon, no registry,
# no network, and no production secrets: the docker/docker-compose CLIs
# and curl are replaced by deterministic PATH shims that emulate the exact
# real Docker/Compose surface the release transaction uses (Compose
# version/config/pull/run/up/ps/port/exec, Docker inspect) plus the curl requests of the
# HEALTH phase. Scripted behavior is controlled by FAKE_* environment
# variables; every shim writes one line per invocation to a shared log.
# The release script — and the backup script it invokes — run unmodified.
#
# Coverage:
#   1. invalid SHA variants (short, mutable tag, branch name, uppercase,
#      39/41-char, malformed, empty) and missing inputs exit non-zero
#      before any runtime operation
#   2. a valid SHA derives exactly <base>-api:<sha> / <base>-web:<sha>
#      (exported into the Compose environment, overriding the env file)
#   3. successful ordering: config validation -> backup -> pull api web ->
#      migrate -> migrate --check -> update api/web -> ps/port -> health ->
#      smoke -> success report
#   4. backup failure halts before pull/migration/update
#   5. pull failure halts before migration/update
#   6. migration failure: no migrate --check, no update, no restore, no
#      automatic retry, no rollback; DB-may-have-changed + recovery
#      artifact report
#   7. migrate --check failure prevents the stack update
#   8. stack-update failure: no rollback, no volume-destructive commands
#   9. health/smoke failure exits non-zero without any rollback
#   10. safety contract: the release never executes a source build, a
#       mutable latest ref, compose down, docker volume rm, an automatic
#       restore, or an old-image restart (runtime log + static source)
#   11. success output contains the SHA, the API ref, the Web ref, and a
#       successful-release indication

set -Eeuo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RELEASE="$REPO_ROOT/deploy/scripts/release.sh"

PASS=0
FAIL=0
FAILED=()

ok()   { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); FAILED+=("$1"); printf 'FAIL %s\n' "$1"; }

CAP_OUT=""
RC=0
run_release() {
  RC=0
  set +e
  CAP_OUT="$(FAKE_STATE_DIR="$STATE" PATH="$SHIM_DIR:$PATH" "$@" 2>&1)" || RC=$?
  set -e
}

expect_rc()         { if [ "$2" -eq "$3" ]; then ok "$1"; else bad "$1 (expected rc=$2, got rc=$3)"; fi; }
expect_rc_nonzero() { if [ "$2" -ne 0 ]; then ok "$1"; else bad "$1 (expected non-zero rc, got 0)"; fi; }
expect_contains()   { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 (missing: $3)" ;; esac; }
expect_not_contains() { case "$2" in *"$3"*) bad "$1 (unexpected: $3)" ;; *) ok "$1" ;; esac; }
expect_eq()         { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

# --- Sanity -----------------------------------------------------------------
[ -x "$RELEASE" ] || { echo "FATAL: $RELEASE missing or not executable"; exit 1; }

# --- Test workspace -----------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fg-release-tests.XXXXXX")"
cleanup_work() { rm -rf -- "$WORK"; }
trap cleanup_work EXIT

SHIM_DIR="$WORK/shim"
STATE="$WORK/fake-state"
ENV_FILE="$WORK/production.env"
BACKUP_DIR="$WORK/backups"
VALID_ARCHIVE="$WORK/valid-archive.bin"
mkdir -p "$SHIM_DIR" "$BACKUP_DIR"

SHA40="dc836752198bd68ce9f58f1604680ccc8f049877"
BASE="ghcr.io/example/fg-workspace"
UPPER40="DC836752198BD68CE9F58F1604680CCC8F049877"
SHORT39="${SHA40%?}"
LONG41="${SHA40}a"
MALFORMED="${SHA40%?}g"

# Deterministic fake custom-format archive bytes.
printf 'PGDMP\nfake custom archive bytes for tests\n' > "$VALID_ARCHIVE"

# env fixture: carries the OLD (mutable-tag) image references on purpose —
# the release must override them with the derived full-SHA refs.
cat > "$ENV_FILE" <<'ENVEOF'
FG_WEB_IMAGE=fg-workspace-web:old-tag
FG_API_IMAGE=fg-workspace-api:old-tag
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
# Deterministic docker CLI shim (release-transaction tests).
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
: "${FAKE_CONFIG_RC:=0}"
: "${FAKE_PULL_RC:=0}"
: "${FAKE_MIGRATE_RC:=0}"
: "${FAKE_CHECK_RC:=0}"
: "${FAKE_UP_RC:=0}"
: "${FAKE_PORT:=127.0.0.1:8080}"
: "${FAKE_HEALTH_OK:=1}"
: "${FAKE_SMOKE_OK:=1}"
: "${FAKE_INSPECT_REVISION:=1}"
: "${FAKE_API_EXISTS:=1}"
: "${FAKE_API_STATUS:=running}"
: "${FAKE_API_HEALTH:=healthy}"
: "${FAKE_API_HEALTH_SEQUENCE:=}"
: "${FAKE_WEB_STATUS:=running}"
: "${FAKE_WEB_HEALTH:=}"
: "${FAKE_DB_STATUS:=running}"
: "${FAKE_DB_HEALTH:=healthy}"

echo "docker $*" >> "$LOG"

# Remember the image references the release exported for Compose (first call).
if [ ! -f "$STATE/env-seen" ]; then
  printf 'api=%s\nweb=%s\n' "${FG_API_IMAGE:-unset}" "${FG_WEB_IMAGE:-unset}" > "$STATE/env-seen"
fi

case "$(basename "$0")" in
  docker-compose) set -- compose "$@" ;;
esac

if [ "${1:-}" = "inspect" ]; then
  [ "${2:-}" = "--format" ] || exit 3
  format="${3:-}"
  container_id="${4:-}"
  case "$container_id" in
    api-container) status="$FAKE_API_STATUS"; health="$FAKE_API_HEALTH" ;;
    web-container) status="$FAKE_WEB_STATUS"; health="$FAKE_WEB_HEALTH" ;;
    db-container)  status="$FAKE_DB_STATUS";  health="$FAKE_DB_HEALTH" ;;
    *) exit 1 ;;
  esac
  case "$format" in
    *State.Status*)
      if [ "$container_id" = "api-container" ] && [ -n "$FAKE_API_HEALTH_SEQUENCE" ]; then
        sequence_count=0
        sequence_count_file="$STATE/api-health-inspect-count"
        if [ -f "$sequence_count_file" ]; then read -r sequence_count < "$sequence_count_file"; fi
        IFS=, read -r -a health_sequence <<< "$FAKE_API_HEALTH_SEQUENCE"
        sequence_index="$sequence_count"
        if [ "$sequence_index" -ge "${#health_sequence[@]}" ]; then
          sequence_index=$((${#health_sequence[@]} - 1))
        fi
        health="${health_sequence[$sequence_index]}"
        printf '%s\n' "$((sequence_count + 1))" > "$sequence_count_file"
      fi
      printf 'inspect-state %s %s|%s\n' "$container_id" "$status" "$health" >> "$LOG"
      printf '%s|%s\n' "$status" "$health"
      ;;
    *org.opencontainers.image.revision*)
      if [ "$FAKE_INSPECT_REVISION" = "1" ]; then
        printf '%s\n' "${FG_API_IMAGE##*:}"
      else
        printf '%s\n' "0000000000000000000000000000000000000000"
      fi
      ;;
    *) exit 3 ;;
  esac
  exit 0
fi

[ "${1:-}" = "compose" ] || exit 3
if [ "${2:-}" = "version" ]; then
  if [ "$FAKE_COMPOSE_OK" = "1" ]; then echo "Docker Compose version fake"; exit 0; fi
  exit 1
fi

# Locate the compose subcommand, skipping the global flags the release
# script always passes (-f, --project-directory, --env-file, --project-name).
set -- "${@:2}"
subcmd=""
rest=()
while [ $# -gt 0 ]; do
  if [ -z "$subcmd" ]; then
    case "$1" in
      -f|--file|--project-directory|--env-file|--project-name|--profile|--log-level) shift 2 ;;
      --*) shift ;;
      *) subcmd="$1"; shift ;;
    esac
  else
    rest+=("$1")
    shift
  fi
done
[ -n "$subcmd" ] || exit 0

case "$subcmd" in
  config)
    exit "$FAKE_CONFIG_RC"
    ;;
  pull)
    [ "${rest[0]:-}" = "api" ] && [ "${rest[1]:-}" = "web" ] || exit 3
    echo "shim: pulled api + web"
    exit "$FAKE_PULL_RC"
    ;;
  run)
    [ "${rest[0]:-}" = "--rm" ] || exit 3
    [ "${rest[1]:-}" = "--no-deps" ] || exit 3
    [ "${rest[2]:-}" = "api" ] || exit 3
    case "${rest[*]:3}" in
      "python manage.py migrate --noinput") exit "$FAKE_MIGRATE_RC" ;;
      "python manage.py migrate --check")   exit "$FAKE_CHECK_RC" ;;
      *) exit 3 ;;
    esac
    ;;
  up)
    # Expected exact contract: -d --no-deps api web
    [ "${rest[0]:-}" = "-d" ] || exit 3
    [ "${rest[1]:-}" = "--no-deps" ] || exit 3
    [ "${rest[2]:-}" = "api" ] || exit 3
    [ "${rest[3]:-}" = "web" ] || exit 3
    [ ${#rest[@]} -eq 4 ] || exit 3
    echo "shim: updated api + web"
    exit "$FAKE_UP_RC"
    ;;
  ps)
    [ "${rest[0]:-}" = "--all" ] || exit 3
    [ "${rest[1]:-}" = "--quiet" ] || exit 3
    [ ${#rest[@]} -eq 3 ] || exit 3
    case "${rest[2]:-}" in
      api) [ "$FAKE_API_EXISTS" = "1" ] && printf '%s\n' "api-container" ;;
      web) printf '%s\n' "web-container" ;;
      db)  printf '%s\n' "db-container" ;;
      *) exit 3 ;;
    esac
    exit 0
    ;;
  port)
    [ "${rest[0]:-}" = "web" ] && [ "${rest[1]:-}" = "8080" ] || exit 3
    printf '%s\n' "$FAKE_PORT"
    exit 0
    ;;
  exec)
    # db-service handling (the backup script's surface).
    [ "${rest[0]:-}" = "-T" ] || exit 0
    [ "${rest[1]:-}" = "db" ] || exit 0
    if [ ${#rest[@]} -gt 2 ]; then rest=("${rest[@]:2}"); else rest=(); fi
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
            tgt="${tgt%?}"
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
    ;;
  *) exit 3 ;;
esac
exit 0
SHIMEOF
chmod 755 "$SHIM_DIR/docker"
cp "$SHIM_DIR/docker" "$SHIM_DIR/docker-compose"

# --- curl shim --------------------------------------------------------------------
cat > "$SHIM_DIR/curl" <<'SHIMEOF'
#!/usr/bin/env bash
# Deterministic curl shim (release-transaction tests).
set -u
: "${FAKE_STATE_DIR:?FAKE_STATE_DIR not set}"
echo "curl $*" >> "${FAKE_STATE_DIR}/exec-log"
url=""
for a in "$@"; do url="$a"; done
case "$url" in
  */api/health*)
    if [ "${FAKE_HEALTH_OK:-1}" = "1" ]; then
      printf '{"status": "ok"}\n'
      exit 0
    fi
    echo "curl: (22) fake health failure for $url" >&2
    exit 22
    ;;
  *)
    if [ "${FAKE_SMOKE_OK:-1}" = "1" ]; then
      printf '<!doctype html>\n<html><head><title>FG Workspace</title></head><body></body></html>\n'
      exit 0
    fi
    echo "curl: (22) fake smoke failure for $url" >&2
    exit 22
    ;;
esac
SHIMEOF
chmod 755 "$SHIM_DIR/curl"

reset_state() {
  rm -rf -- "$STATE"
  mkdir -p "$STATE"
  find "$BACKUP_DIR" -mindepth 1 -delete
}

# Standard release invocation (all required inputs, valid SHA).
SUCCESS_ARGS=("$RELEASE" "$SHA40" --env-file "$ENV_FILE" --image-base "$BASE" --backup-dir "$BACKUP_DIR")

log_lines() { if [ -f "$STATE/exec-log" ]; then cat "$STATE/exec-log"; fi; }
log_count() { printf '%s\n' "$(log_lines)" | grep -c -- "$1" || true; }
# restore operations = log lines mentioning restore that are NOT the
# backup primitive's read-only pg_restore --list archive validation.
restore_ops() {
  printf '%s\n' "$(log_lines)" | grep "restore" | grep -vc -- "--list" || true
}
line_of() {
  if [ -f "$STATE/exec-log" ]; then
    grep -n -m1 -- "$1" "$STATE/exec-log" | cut -d: -f1 || true
  fi
}

# =============================================================================
# 1. Invalid release identity / missing inputs — fail before any runtime op
# =============================================================================

for bad_sha in "latest" "main" "feature/branch-name" "$SHORT39" "$LONG41" "$UPPER40" "$MALFORMED" ""; do
  reset_state
  run_release "$RELEASE" "$bad_sha" --env-file "$ENV_FILE" --image-base "$BASE" --backup-dir "$BACKUP_DIR"
  expect_rc_nonzero "invalid SHA '$bad_sha' rejected" "$RC"
  expect_eq "invalid SHA '$bad_sha' made no runtime call" "$(log_lines | wc -l | tr -d ' ')" "0"
  ls "$BACKUP_DIR" | grep -q . && bad "invalid SHA '$bad_sha' left artifacts" || ok "invalid SHA '$bad_sha' left no artifacts"
done

reset_state
run_release "$RELEASE"
expect_rc_nonzero "missing SHA rejected" "$RC"
expect_eq "missing SHA made no runtime call" "$(log_lines | wc -l | tr -d ' ')" "0"

reset_state
run_release "$RELEASE" "$SHA40" --env-file "$ENV_FILE" --backup-dir "$BACKUP_DIR"
expect_rc_nonzero "missing --image-base rejected" "$RC"
expect_eq "missing --image-base made no runtime call" "$(log_lines | wc -l | tr -d ' ')" "0"

reset_state
run_release "$RELEASE" "$SHA40" --env-file "$ENV_FILE" --image-base "$BASE"
expect_rc_nonzero "missing --backup-dir rejected" "$RC"
expect_eq "missing --backup-dir made no runtime call" "$(log_lines | wc -l | tr -d ' ')" "0"

reset_state
run_release "$RELEASE" "$SHA40" --env-file "$ENV_FILE" --image-base "$BASE" --backup-dir "$WORK/no-such-dir"
expect_rc_nonzero "nonexistent --backup-dir rejected" "$RC"
expect_contains "nonexistent --backup-dir names phase VALIDATION" "$CAP_OUT" "phase=VALIDATION"
expect_eq "nonexistent --backup-dir made no runtime call" "$(log_lines | wc -l | tr -d ' ')" "0"

reset_state
run_release "$RELEASE" "$SHA40" --env-file "$ENV_FILE" --image-base "$BASE:old-tag" --backup-dir "$BACKUP_DIR"
expect_rc_nonzero "image base carrying a tag rejected" "$RC"
expect_contains "tagged image base names phase VALIDATION" "$CAP_OUT" "phase=VALIDATION"

reset_state
run_release "$RELEASE" "$SHA40" --image-base "$BASE" --backup-dir "$BACKUP_DIR"
expect_rc_nonzero "missing --env-file (no default deploy/.env) rejected" "$RC"
expect_eq "missing --env-file made no runtime call" "$(log_lines | wc -l | tr -d ' ')" "0"

# =============================================================================
# 2 + 3 + 10 (runtime) + 11. Successful release
# =============================================================================

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc "release success exits 0" 0 "$RC"

# (2) exact derivation, exported into the Compose environment (which
# overrides the env file's old-tag references).
expect_eq "derived FG_API_IMAGE exported to Compose" \
  "$(sed -n 's/^api=//p' "$STATE/env-seen")" "$BASE-api:$SHA40"
expect_eq "derived FG_WEB_IMAGE exported to Compose" \
  "$(sed -n 's/^web=//p' "$STATE/env-seen")" "$BASE-web:$SHA40"

# (3) observable ordering of the whole transaction.
L_CFG="$(line_of "config --quiet")"
L_DUMP="$(line_of "pg_dump -Fc")"
L_PULL="$(line_of "pull api web")"
L_MIG="$(line_of "migrate --noinput")"
L_CHK="$(line_of "migrate --check")"
L_UP="$(line_of "up -d --no-deps api web")"
L_PS="$(line_of "ps --all --quiet api")"
L_PORT="$(line_of "port web 8080")"
L_CURL="$(line_of "^curl")"
if [ -n "$L_CFG" ] && [ -n "$L_DUMP" ] && [ -n "$L_PULL" ] && [ -n "$L_MIG" ] \
   && [ -n "$L_CHK" ] && [ -n "$L_UP" ] && [ -n "$L_PS" ] && [ -n "$L_PORT" ] \
   && [ -n "$L_CURL" ] \
   && [ "$L_CFG" -lt "$L_DUMP" ] && [ "$L_DUMP" -lt "$L_PULL" ] \
   && [ "$L_PULL" -lt "$L_MIG" ] && [ "$L_MIG" -lt "$L_CHK" ] \
   && [ "$L_CHK" -lt "$L_UP" ] && [ "$L_UP" -lt "$L_PS" ] \
   && [ "$L_PS" -lt "$L_PORT" ] && [ "$L_PORT" -lt "$L_CURL" ]; then
  ok "ordering: config -> backup -> pull -> migrate -> check -> update -> ps/port -> health"
else
  bad "ordering broken (cfg=$L_CFG dump=$L_DUMP pull=$L_PULL mig=$L_MIG chk=$L_CHK up=$L_UP ps=$L_PS port=$L_PORT curl=$L_CURL)"
fi
expect_eq "exactly one real migrate per release" "$(log_count "migrate --noinput")" "1"
expect_eq "exactly one migrate --check" "$(log_count "migrate --check")" "1"
expect_eq "backup ran through the backup primitive" "$(log_count "pg_dump -Fc -U accuser -d accdb")" "1"
expect_eq "service gate resolves each container through Compose" "$(log_count "ps --all --quiet")" "3"
expect_eq "service gate inspects each container through Docker" "$(log_count "docker inspect --format {{.State.Status}}")" "3"
expect_eq "OCI advisory inspects api/web through Docker" "$(log_count "org.opencontainers.image.revision")" "2"

# (11) success report content.
expect_contains "report: requested SHA" "$CAP_OUT" "$SHA40"
expect_contains "report: API image ref" "$CAP_OUT" "$BASE-api:$SHA40"
expect_contains "report: Web image ref" "$CAP_OUT" "$BASE-web:$SHA40"
expect_contains "report: successful release indication" "$CAP_OUT" "RELEASE SUCCESS"
expect_contains "report: backup success" "$CAP_OUT" "backup:          ok (predeploy)"
expect_contains "report: migration success" "$CAP_OUT" "migration:       ok"
expect_contains "report: health success" "$CAP_OUT" "health:          ok"
expect_contains "report: liveness via web gateway" "$CAP_OUT" "http://127.0.0.1:8080/api/health/"
expect_contains "report: gateway smoke" "$CAP_OUT" "smoke:           ok"
expect_contains "report: schema readiness" "$CAP_OUT" "ready — manage.py migrate --check passed"
expect_contains "report: revision label verified on both containers" \
  "$CAP_OUT" "org.opencontainers.image.revision matches $SHA40 on both running api and web containers"

# (10, runtime log) safety contract over the executed command sequence.
expect_eq "safety: no source build in the run" "$(log_count "build")" "0"
expect_eq "safety: no mutable latest ref in the run" "$(log_count ":latest")" "0"
expect_eq "safety: no compose down in the run" "$(log_count " down")" "0"
expect_eq "safety: no volume command in the run" "$(log_count "volume")" "0"
expect_eq "safety: no automatic restore op in the run (pg_restore --list validation only)" "$(restore_ops)" "0"
expect_eq "safety: no old-image restart in the run" "$(log_count "restart")" "0"
expect_eq "safety: no bare start command in the run" "$(log_count " start ")" "0"
expect_not_contains "safety: env-file old tags never pulled" "$CAP_OUT" "old-tag"

# (10, static source) safety contract over the release script itself.
SRC="$(cat "$RELEASE")"
expect_not_contains "safety: source has no :latest" "$SRC" ":latest"
expect_not_contains "safety: source never invokes the restore primitive" "$SRC" "restore-empty"
expect_not_contains "safety: source never invokes pg_restore" "$SRC" "pg_restore"
expect_not_contains "safety: source never removes volumes" "$SRC" "volume rm"
expect_eq "safety: source has no 'down' command word" "$(printf '%s\n' "$SRC" | grep -cw "down" || true)" "0"
expect_eq "safety: source has no 'build' command word" "$(printf '%s\n' "$SRC" | grep -cw "build" || true)" "0"
expect_eq "safety: source has no 'latest' command word" "$(printf '%s\n' "$SRC" | grep -cw "latest" || true)" "0"
expect_eq "safety: source has no 'restart' command word" "$(printf '%s\n' "$SRC" | grep -cw "restart" || true)" "0"
expect_not_contains "Docker contract: source has no fake compose inspect" "$SRC" "compose inspect"
expect_contains "Docker contract: source uses regular Docker inspect" "$SRC" "docker inspect --format"
SHIM_SRC="$(cat "$SHIM_DIR/docker")"
expect_not_contains "Docker contract: shim has no Compose inspect subcommand" "$SHIM_SRC" "  inspect)"

# =============================================================================
# 4. Backup failure halts before pull / migration / update
# =============================================================================

reset_state
FAKE_DUMP_RC=1 run_release "${SUCCESS_ARGS[@]}"
expect_rc_nonzero "backup failure halts the release" "$RC"
expect_contains "backup failure names phase BACKUP" "$CAP_OUT" "phase=BACKUP"
expect_eq "backup failure: no pull" "$(log_count "pull api web")" "0"
expect_eq "backup failure: no migration" "$(log_count "migrate")" "0"
expect_eq "backup failure: no stack update" "$(log_count "up -d")" "0"
expect_eq "backup failure: no health probe" "$(log_count "curl")" "0"
ls "$BACKUP_DIR" | grep -q . && bad "backup failure left artifacts" || ok "backup failure left no final artifact"

# =============================================================================
# 5. Pull failure halts before migration / update
# =============================================================================

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_PULL_RC=1 \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc_nonzero "pull failure halts the release" "$RC"
expect_contains "pull failure names phase IMAGE_PULL" "$CAP_OUT" "phase=IMAGE_PULL"
expect_eq "pull failure: backup did run" "$(log_count "pg_dump -Fc")" "1"
expect_eq "pull failure: no migration" "$(log_count "migrate")" "0"
expect_eq "pull failure: no stack update" "$(log_count "up -d")" "0"
expect_eq "pull failure: no health probe" "$(log_count "curl")" "0"

# =============================================================================
# 6. Migration failure: no check, no update, no restore, no retry, no rollback
# =============================================================================

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_MIGRATE_RC=1 \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc_nonzero "migration failure halts the release" "$RC"
expect_contains "migration failure names phase MIGRATION" "$CAP_OUT" "phase=MIGRATION"
expect_eq "migration failure: migrate --check absent" "$(log_count "migrate --check")" "0"
expect_eq "migration failure: no automatic retry (exactly one migrate attempt)" "$(log_count "migrate --noinput")" "1"
expect_eq "migration failure: no stack update" "$(log_count "up -d")" "0"
expect_eq "migration failure: no health probe" "$(log_count "curl")" "0"
expect_eq "migration failure: no restore op" "$(restore_ops)" "0"
expect_eq "migration failure: no down" "$(log_count " down")" "0"
expect_eq "migration failure: no restart" "$(log_count "restart")" "0"
expect_contains "migration failure: DB may have changed" "$CAP_OUT" "MAY HAVE CHANGED"
expect_contains "migration failure: operator recovery required" "$CAP_OUT" "REQUIRED"
expect_contains "migration failure: backup identified as recovery artifact" "$CAP_OUT" "recovery artifact"

# =============================================================================
# 7. migrate --check failure prevents the stack update
# =============================================================================

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_CHECK_RC=1 \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc_nonzero "migrate --check failure halts the release" "$RC"
expect_contains "check failure names phase MIGRATION" "$CAP_OUT" "phase=MIGRATION"
expect_eq "check failure: one real migrate ran" "$(log_count "migrate --noinput")" "1"
expect_eq "check failure: the check ran once" "$(log_count "migrate --check")" "1"
expect_eq "check failure: no stack update" "$(log_count "up -d")" "0"
expect_eq "check failure: no health probe" "$(log_count "curl")" "0"
expect_contains "check failure: stack NOT updated" "$CAP_OUT" "stack was NOT updated"

# =============================================================================
# 8. Stack-update failure: no rollback, no volume-destructive commands
# =============================================================================

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_UP_RC=1 \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc_nonzero "stack-update failure halts the release" "$RC"
expect_contains "update failure names phase STACK_UPDATE" "$CAP_OUT" "phase=STACK_UPDATE"
expect_eq "update failure: exactly one (legitimate) update attempt" "$(log_count "up -d --no-deps api web")" "1"
expect_eq "update failure: no health probe" "$(log_count "curl")" "0"
expect_eq "update failure: no down" "$(log_count " down")" "0"
expect_eq "update failure: no volume command" "$(log_count "volume")" "0"
expect_eq "update failure: no restore op" "$(restore_ops)" "0"
expect_eq "update failure: no restart" "$(log_count "restart")" "0"
expect_contains "update failure: DB already migrated" "$CAP_OUT" "ALREADY BEEN MIGRATED"
expect_contains "update failure: operator intervention reported" "$CAP_OUT" "operator intervention may be necessary"

# =============================================================================
# 9. Container running/health state is a real gate before HTTP
# =============================================================================

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_API_EXISTS=0 \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc_nonzero "missing api container fails HEALTH" "$RC"
expect_contains "missing api names phase HEALTH" "$CAP_OUT" "phase=HEALTH"
expect_contains "missing api reports absent container" "$CAP_OUT" "service 'api' has no container"
expect_eq "missing api fails before HTTP smoke" "$(log_count "curl")" "0"

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_API_STATUS=exited \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc_nonzero "stopped api container fails HEALTH" "$RC"
expect_contains "stopped api reports non-running state" "$CAP_OUT" "status: exited"
expect_eq "stopped api fails before HTTP smoke" "$(log_count "curl")" "0"

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_API_HEALTH=unhealthy \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc_nonzero "unhealthy api container fails HEALTH" "$RC"
expect_contains "unhealthy api reports health state" "$CAP_OUT" "service 'api' container health is 'unhealthy'"
expect_eq "unhealthy api fails before HTTP smoke" "$(log_count "curl")" "0"

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_DB_HEALTH=unhealthy \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc_nonzero "unhealthy db container fails HEALTH" "$RC"
expect_contains "unhealthy db reports health state" "$CAP_OUT" "service 'db' container health is 'unhealthy'"
expect_eq "unhealthy db fails before HTTP smoke" "$(log_count "curl")" "0"

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" \
  FAKE_API_HEALTH_SEQUENCE=starting,healthy \
  FG_RELEASE_HEALTH_ATTEMPTS=2 FG_RELEASE_HEALTH_DELAY_SECONDS=0 \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc "transient api startup succeeds" 0 "$RC"
expect_eq "transient api startup inspects starting once" "$(log_count "inspect-state api-container running|starting")" "1"
expect_eq "transient api startup later inspects healthy once" "$(log_count "inspect-state api-container running|healthy")" "1"
L_API_STARTING="$(line_of "inspect-state api-container running|starting")"
L_API_HEALTHY="$(line_of "inspect-state api-container running|healthy")"
L_TRANSIENT_CURL="$(line_of "^curl")"
if [ -n "$L_API_STARTING" ] && [ -n "$L_API_HEALTHY" ] && [ -n "$L_TRANSIENT_CURL" ] \
   && [ "$L_API_STARTING" -lt "$L_API_HEALTHY" ] && [ "$L_API_HEALTHY" -lt "$L_TRANSIENT_CURL" ]; then
  ok "transient api startup reaches healthy before HTTP smoke"
else
  bad "transient api readiness ordering broken (starting=$L_API_STARTING healthy=$L_API_HEALTHY curl=$L_TRANSIENT_CURL)"
fi

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_API_HEALTH=starting \
  FG_RELEASE_HEALTH_ATTEMPTS=3 FG_RELEASE_HEALTH_DELAY_SECONDS=0 \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc_nonzero "persistent api startup times out" "$RC"
expect_contains "persistent api startup names phase HEALTH" "$CAP_OUT" "phase=HEALTH"
expect_contains "persistent api startup reports readiness timeout" "$CAP_OUT" "container readiness timed out after 3 attempts"
expect_contains "persistent api startup identifies api" "$CAP_OUT" "health still starting: api"
expect_eq "persistent api startup consumes the bounded budget" "$(log_count "inspect-state api-container running|starting")" "3"
expect_eq "persistent api startup times out before HTTP smoke" "$(log_count "curl")" "0"

# =============================================================================
# 10. Published-port parsing produces connectable IPv4/IPv6 URLs
# =============================================================================

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_PORT="[::1]:8080" \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc "bracketed IPv6 mapping succeeds" 0 "$RC"
expect_contains "bracketed IPv6 is not double-bracketed" "$CAP_OUT" "http://[::1]:8080/api/health/"
expect_not_contains "bracketed IPv6 has no malformed double brackets" "$CAP_OUT" "[[::1]]"

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_PORT="0.0.0.0:49152" \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc "IPv4 wildcard mapping succeeds" 0 "$RC"
expect_contains "IPv4 wildcard probes loopback" "$CAP_OUT" "http://127.0.0.1:49152/api/health/"

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_PORT="[::]:49153" \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc "IPv6 wildcard mapping succeeds" 0 "$RC"
expect_contains "IPv6 wildcard probes loopback" "$CAP_OUT" "http://[::1]:49153/api/health/"

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_PORT=":::49154" \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc "bare IPv6 wildcard mapping succeeds" 0 "$RC"
expect_contains "bare IPv6 wildcard probes loopback" "$CAP_OUT" "http://[::1]:49154/api/health/"

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_PORT="not-a-port-mapping" \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc_nonzero "malformed published-port mapping fails HEALTH" "$RC"
expect_contains "malformed mapping reports the Compose output" "$CAP_OUT" "unexpected mapping: not-a-port-mapping"
expect_eq "malformed mapping fails before curl" "$(log_count "curl")" "0"

# =============================================================================
# 11. Health / smoke failure exits non-zero without any rollback
# =============================================================================

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" \
  FAKE_HEALTH_OK=0 FG_RELEASE_HEALTH_ATTEMPTS=2 FG_RELEASE_HEALTH_DELAY_SECONDS=0 \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc_nonzero "health failure halts the release" "$RC"
expect_contains "health failure names phase HEALTH" "$CAP_OUT" "phase=HEALTH"
expect_eq "health failure: bounded attempts (exactly 2)" "$(log_count "api/health/")" "2"
expect_eq "health failure: no down" "$(log_count " down")" "0"
expect_eq "health failure: no restore op" "$(restore_ops)" "0"
expect_eq "health failure: no rollback update (the legitimate update ran once)" "$(log_count "up -d --no-deps api web")" "1"

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_SMOKE_OK=0 \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc_nonzero "smoke failure halts the release" "$RC"
expect_contains "smoke failure names phase HEALTH" "$CAP_OUT" "phase=HEALTH"
expect_eq "smoke failure: health liveness ran once" "$(log_count "api/health/")" "1"
expect_eq "smoke failure: no down" "$(log_count " down")" "0"
expect_eq "smoke failure: no restore op" "$(restore_ops)" "0"

# =============================================================================
# Advisory: revision-label mismatch never fails the release
# =============================================================================

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" FAKE_INSPECT_REVISION=0 \
  run_release "${SUCCESS_ARGS[@]}"
expect_rc "revision-label mismatch still succeeds (advisory)" 0 "$RC"
expect_contains "revision advisory reported" "$CAP_OUT" "does not match"

# =============================================================================
# --project-name is forwarded to every Compose operation and the backup
# =============================================================================

reset_state
FAKE_DUMP_FILE="$VALID_ARCHIVE" FAKE_VALID_ARCHIVE_FILE="$VALID_ARCHIVE" \
  run_release "$RELEASE" "$SHA40" --env-file "$ENV_FILE" --image-base "$BASE" \
    --backup-dir "$BACKUP_DIR" --project-name relproj
expect_rc "--project-name success exits 0" 0 "$RC"
expect_contains "--project-name passed to compose" "$(log_lines)" "--project-name relproj"

# --- Summary --------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  for t in ${FAILED[@]+"${FAILED[@]}"}; do printf '  failed: %s\n' "$t"; done
  exit 1
fi
exit 0
