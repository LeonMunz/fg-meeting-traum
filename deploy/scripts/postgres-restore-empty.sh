#!/usr/bin/env bash
#
# FG Workspace — operator PostgreSQL restore into an EMPTY database ONLY.
#
# Restores a `pg_dump -Fc` archive (produced by
# deploy/scripts/postgres-backup.sh) into the configured application
# database of the running Compose `db` service, with one hard safety rule:
# the target database must contain NO user/application objects.
#
# Usage:
#   deploy/scripts/postgres-restore-empty.sh --env-file /path/to/env \
#     --archive /path/to/backup.dump [--checksum /path/to/backup.dump.sha256]
#
# Preconditions, enforced IN ORDER and ALL before any database write:
#   1. the archive exists and is a non-empty regular file;
#   2. the SHA-256 checksum sidecar (default: <archive>.sha256, overridable
#      with --checksum) exists, is a single well-formed line naming exactly
#      this archive, and matches — a missing or invalid checksum fails
#      closed BEFORE any Docker/PostgreSQL interaction;
#   3. the archive parses: `pg_restore --list` through the db container;
#   4. the target database is EMPTY: no user-schema relations (tables,
#      views, materialized views, sequences, foreign/partitioned tables)
#      and no user functions. System catalogs/schemas never count. A
#      non-empty (e.g. already migrated or populated) target is refused
#      with a clear message, ZERO changes, and a non-zero exit.
#
# The restore then runs `pg_restore --exit-on-error` into the EXISTING
# configured application database. The image bootstrap owns database
# creation: this script never creates, drops, cleans, or deletes anything.
# There is deliberately NO --force, NO destructive bypass of the emptiness
# guard, NO --clean, NO --create, and NO automatic volume deletion.
#
# Ownership/ACL: no --no-owner / --no-acl. The runtime contract recreates
# the SAME application role from POSTGRES_USER on a fresh volume, so the
# archived ownership and ACLs restore cleanly and the archive stays
# authoritative.
#
# If pg_restore fails part-way, the target may hold PARTIAL objects. A
# restore is only ever valid into an empty database, so re-prepare a fresh
# empty target (e.g. a fresh external volume) before any retry.
#
# Boundaries (see docs/living-lab.md): logical recovery point only (no
# PITR/WAL); single-database scope (no pg_dumpall — the application role is
# runtime configuration); destructive in-place production cutover is
# explicitly out of scope (later runbook slice).

set -Eeuo pipefail
umask 077

log()  { printf '%s\n' "$*" >&2; }
fail() { log "postgres-restore-empty: ERROR: $*"; exit 1; }

usage() {
  cat >&2 <<'USAGE'
Usage: postgres-restore-empty.sh --env-file <path> --archive <path> [--checksum <path>] [--project-name <name>]

  --env-file <path>      Compose .env file for deploy/compose.production.yaml
                         (same file the stack runs with).
  --archive <path>       Non-empty pg_dump -Fc archive to restore.
  --checksum <path>      Optional. SHA-256 sidecar for the archive.
                         Default: <archive>.sha256.
  --project-name <name>  Compose project name of the target stack. Default:
                         the project declared in the Compose file
                         (fg-production); pass it for stacks started under a
                         non-default project name.

Restores ONLY into an EMPTY target database. A non-empty target is refused
(no --force, no destructive overwrite). See the script header and
docs/living-lab.md for the full contract.
USAGE
}

ENV_FILE=""
ARCHIVE=""
CHECKSUM_FILE=""
PROJECT_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file)     if [ $# -lt 2 ]; then usage; exit 2; fi; ENV_FILE="$2"; shift 2 ;;
    --archive)      if [ $# -lt 2 ]; then usage; exit 2; fi; ARCHIVE="$2"; shift 2 ;;
    --checksum)     if [ $# -lt 2 ]; then usage; exit 2; fi; CHECKSUM_FILE="$2"; shift 2 ;;
    --project-name) if [ $# -lt 2 ]; then usage; exit 2; fi; PROJECT_NAME="$2"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *)            log "postgres-restore-empty: ERROR: unknown option '$1' (this script has no destructive overrides)"; usage; exit 2 ;;
  esac
done
if [ -z "$ENV_FILE" ] || [ -z "$ARCHIVE" ]; then usage; exit 2; fi

# --- Resolve repository / Compose file (caller-CWD independent) ----------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/deploy/compose.production.yaml"
if [ ! -f "$COMPOSE_FILE" ]; then fail "Compose file not found: $COMPOSE_FILE"; fi

# --- 1) Host-side checks (NO Docker interaction yet) -------------------------
if [ ! -f "$ARCHIVE" ]; then fail "archive not found: $ARCHIVE"; fi
ARCHIVE="$(cd -- "$(dirname -- "$ARCHIVE")" && pwd)/$(basename -- "$ARCHIVE")"
if [ ! -s "$ARCHIVE" ]; then fail "archive is empty: $ARCHIVE"; fi
if [ ! -f "$ENV_FILE" ] || [ ! -r "$ENV_FILE" ]; then
  fail "env file not found or unreadable: $ENV_FILE"
fi
ENV_FILE="$(cd -- "$(dirname -- "$ENV_FILE")" && pwd)/$(basename -- "$ENV_FILE")"
if [ -z "$CHECKSUM_FILE" ]; then CHECKSUM_FILE="${ARCHIVE}.sha256"; fi
if [ ! -f "$CHECKSUM_FILE" ] || [ ! -r "$CHECKSUM_FILE" ]; then
  fail "checksum sidecar not found or unreadable: $CHECKSUM_FILE — restore refuses to proceed without a verifiable checksum (fail closed; no database access attempted)"
fi

hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum < "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 < "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl sha256 < "$1" | awk '{print $NF}'
  else
    return 1
  fi
}

# --- 2) Checksum verification (still NO Docker interaction) ------------------
if [ -n "$(tail -n +2 -- "$CHECKSUM_FILE")" ]; then
  fail "checksum sidecar is malformed (expected exactly one line): $CHECKSUM_FILE"
fi
EXPECTED_HASH="$(awk '{print $1}' "$CHECKSUM_FILE")"
EXPECTED_NAME="$(awk '{print $2}' "$CHECKSUM_FILE" | sed 's/^\*//')"
case "$EXPECTED_HASH" in
  *[!0-9a-f]*) fail "checksum sidecar is malformed (hash is not 64 lowercase hex characters): $CHECKSUM_FILE" ;;
esac
if [ "${#EXPECTED_HASH}" -ne 64 ]; then
  fail "checksum sidecar is malformed (wrong hash length): $CHECKSUM_FILE"
fi
if [ -z "$EXPECTED_NAME" ]; then
  fail "checksum sidecar names no archive: $CHECKSUM_FILE"
fi
if [ "$EXPECTED_NAME" != "$(basename -- "$ARCHIVE")" ]; then
  fail "checksum sidecar identifies '$EXPECTED_NAME', not this archive ('$(basename -- "$ARCHIVE")') — refusing to restore"
fi
if ! ACTUAL_HASH="$(hash_of "$ARCHIVE")"; then
  fail "no SHA-256 facility available on this host (sha256sum/shasum/openssl)"
fi
if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
  fail "SHA-256 checksum MISMATCH for $ARCHIVE — the archive or its sidecar is corrupt/wrong; refusing to restore (no database changes were made)"
fi
log "postgres-restore-empty: checksum verified: $ACTUAL_HASH"

# --- Compose CLI with a reachable daemon ---------------------------------------
COMPOSE_CLI=()
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CLI=(docker compose)
elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
  COMPOSE_CLI=(docker-compose)
else
  fail "no usable Compose CLI with a reachable Docker daemon (tried 'docker compose' and 'docker-compose')"
fi

if [ -n "$PROJECT_NAME" ]; then
  compose() {
    "${COMPOSE_CLI[@]}" -f "$COMPOSE_FILE" --project-directory "$REPO_ROOT/deploy" --env-file "$ENV_FILE" --project-name "$PROJECT_NAME" "$@"
  }
else
  compose() {
    "${COMPOSE_CLI[@]}" -f "$COMPOSE_FILE" --project-directory "$REPO_ROOT/deploy" --env-file "$ENV_FILE" "$@"
  }
fi

env_value() {
  local key="$1" line value
  line="$(sed -n -E "s/^[[:space:]]*${key}=(.*)\$/\1/p" "$ENV_FILE" | tail -n 1)"
  if [ -z "$line" ]; then fail "env file does not define ${key}: $ENV_FILE"; fi
  value="$(printf '%s' "$line" | sed -E -e 's/[[:space:]]+#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  if [ -z "$value" ]; then fail "env file value for ${key} is empty: $ENV_FILE"; fi
  printf '%s' "$value"
}

POSTGRES_DB="$(env_value POSTGRES_DB)"
POSTGRES_USER="$(env_value POSTGRES_USER)"

# --- db service usability --------------------------------------------------------
if ! compose exec -T db sh -c 'exit 0' >/dev/null 2>&1; then
  fail "db service is not usable (container missing or not running). Start the stack first: ${COMPOSE_CLI[*]} -f deploy/compose.production.yaml up -d"
fi
if ! compose exec -T db pg_isready -q >/dev/null 2>&1; then
  fail "db service is not accepting connections yet (pg_isready failed)"
fi

# --- 3) Archive parse validation (via the container toolchain) ---------------------
STAGE="/tmp/fg-restore-$$.dump"
cleanup() {
  local rc=$?
  trap - EXIT
  if [ -n "$STAGE" ] && [ ${#COMPOSE_CLI[@]} -gt 0 ]; then
    compose exec -T db rm -f -- "$STAGE" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

log "postgres-restore-empty: validating archive (pg_restore --list via db container)"
if ! compose exec -T db sh -c "cat > '$STAGE'" < "$ARCHIVE"; then
  STAGE=""
  fail "staging the archive into the db container failed"
fi
if ! compose exec -T db pg_restore --list "$STAGE" >/dev/null 2>&1; then
  STAGE=""
  fail "archive validation failed: pg_restore --list rejected the archive (no database changes were made)"
fi
compose exec -T db rm -f -- "$STAGE" >/dev/null 2>&1 || true
STAGE=""

# --- 4) Target emptiness check (hard guard) ---------------------------------------------
EMPTYNESS_SQL="SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND c.relkind IN ('r','v','m','S','f','p')),
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog','information_schema'))"

log "postgres-restore-empty: checking target database '${POSTGRES_DB}' is empty"
RESULT="$(compose exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$EMPTYNESS_SQL")" \
  || fail "emptiness check failed while querying the target database (no changes were made)"
REL_COUNT="${RESULT%%|*}"
FUNC_COUNT="${RESULT##*|}"
case "$REL_COUNT$FUNC_COUNT" in
  *[!0-9]*|"") fail "emptiness check returned an unexpected result: '$RESULT' (no changes were made)" ;;
esac
if [ "$REL_COUNT" -ne 0 ] || [ "$FUNC_COUNT" -ne 0 ]; then
  cat >&2 <<REFUSAL
postgres-restore-empty: REFUSED: target database '${POSTGRES_DB}' is NOT empty
  (${REL_COUNT} user-schema relation(s), ${FUNC_COUNT} user function(s) present).
This script restores ONLY into an empty database; it will never overwrite an
existing database. No changes were made.
To recover a backup, prepare a fresh EMPTY target (e.g. a fresh external
volume bootstrapped with the same env contract) and run this script against it.
REFUSAL
  exit 1
fi

# --- 5) Restore (exit-on-error; no --clean, no --create) ------------------------------
log "postgres-restore-empty: restoring archive into '${POSTGRES_DB}' (pg_restore --exit-on-error)"
STAGE="/tmp/fg-restore-$$.dump"
if ! compose exec -T db sh -c "cat > '$STAGE'" < "$ARCHIVE"; then
  STAGE=""
  fail "staging the archive into the db container failed"
fi
if ! compose exec -T db pg_restore --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --exit-on-error "$STAGE"; then
  STAGE=""
  fail "pg_restore FAILED — the target may now contain PARTIAL objects. A restore is only valid into an empty database: re-prepare a fresh empty target before any retry."
fi
compose exec -T db rm -f -- "$STAGE" >/dev/null 2>&1 || true
STAGE=""

# --- 6) Post-restore verification (direct database evidence) ----------------------------
POST="$(compose exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$EMPTYNESS_SQL")" \
  || fail "post-restore verification query failed"
POST_REL="${POST%%|*}"
case "$POST_REL" in
  *[!0-9]*|"") fail "post-restore verification returned an unexpected result: '$POST'" ;;
esac
if [ "$POST_REL" -le 0 ]; then
  fail "post-restore verification: target still has no user-schema relations — the restore produced nothing"
fi
log "postgres-restore-empty: DONE — ${POST_REL} user-schema relation(s) present in '${POSTGRES_DB}' after restore"
