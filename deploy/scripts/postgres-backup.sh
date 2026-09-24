#!/usr/bin/env bash
#
# FG Workspace — operator PostgreSQL backup (logical database archive).
#
# Creates one validated `pg_dump -Fc` (custom format) archive of the
# configured application database on the host filesystem, using the
# running Compose `db` service of the local production topology
# (deploy/compose.production.yaml).
#
# Usage:
#   deploy/scripts/postgres-backup.sh --env-file /path/to/env --output-dir /path/to/backups
#
# Behavior contract:
#   * LIVE: the database keeps serving traffic. This script never stops
#     PostgreSQL, api, or web, never pauses the Compose stack, and never
#     takes manual locks; pg_dump produces a consistent logical snapshot
#     within its own transaction.
#   * All PostgreSQL tooling runs inside the pinned `db` container
#     (postgres:16.15-bookworm, digest-pinned). No host PostgreSQL client
#     is required and no host port is opened. Every PostgreSQL connection
#     is made explicitly as the runtime-contract application role
#     (POSTGRES_USER) — never as the container's OS user.
#   * The archive is written to `<final>.partial` first and is published
#     by an atomic rename only after: (1) a non-empty check and (2) a
#     successful `pg_restore --list` parse of the staged archive through
#     the container toolchain.
#   * A SHA-256 sidecar `<final>.sha256` (sha256sum-compatible format,
#     one line: `<hash>  <archive-basename>`) is generated after
#     publication and self-verified.
#   * Artifacts are created with restrictive permissions (umask 077 ->
#     0600). The output directory must exist, be writable, and must NOT
#     be inside the repository.
#   * On ANY failure: no final-looking archive remains, the partial
#     artifact is removed, and the exit code is non-zero.
#
# Recovery boundaries (documented; see docs/living-lab.md):
#   * This is a LOGICAL, single-database recovery point: it is NOT a full
#     PostgreSQL cluster backup (no pg_dumpall — runtime configuration is
#     the source of truth for the application DB role, recreated from
#     POSTGRES_USER / POSTGRES_PASSWORD on a fresh volume, and no custom
#     tablespaces exist in this architecture) and it does NOT provide
#     Point-in-Time Recovery (no WAL archiving; the server configuration
#     is never modified).
#   * Scheduling, retention/rotation, off-host upload, and encryption are
#     NOT implemented (later slices).

set -Eeuo pipefail
umask 077

log()  { printf '%s\n' "$*" >&2; }
fail() { log "postgres-backup: ERROR: $*"; exit 1; }

usage() {
  cat >&2 <<'USAGE'
Usage: postgres-backup.sh --env-file <path> --output-dir <path> [--project-name <name>]

  --env-file <path>     Compose .env file for deploy/compose.production.yaml
                        (must define all required values, incl. POSTGRES_DB).
  --output-dir <path>   Existing, writable directory OUTSIDE the repository
                        where the archive and its .sha256 sidecar are written.
  --project-name <name> Compose project name of the running stack. Default:
                        the project declared in the Compose file
                        (fg-production); pass it for stacks started under a
                        non-default project name.

Creates: <output-dir>/fg-workspace-<database>-YYYYMMDDTHHMMSSZ.dump (+ .sha256)
The database stays online for the entire backup.
USAGE
}

ENV_FILE=""
OUTPUT_DIR=""
PROJECT_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file)     if [ $# -lt 2 ]; then usage; exit 2; fi; ENV_FILE="$2"; shift 2 ;;
    --output-dir)   if [ $# -lt 2 ]; then usage; exit 2; fi; OUTPUT_DIR="$2"; shift 2 ;;
    --project-name) if [ $# -lt 2 ]; then usage; exit 2; fi; PROJECT_NAME="$2"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *)              usage; exit 2 ;;
  esac
done
if [ -z "$ENV_FILE" ] || [ -z "$OUTPUT_DIR" ]; then usage; exit 2; fi

# --- Resolve repository / Compose file (caller-CWD independent) ----------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/deploy/compose.production.yaml"
if [ ! -f "$COMPOSE_FILE" ]; then fail "Compose file not found: $COMPOSE_FILE"; fi

# --- Validate inputs -------------------------------------------------------
if [ ! -f "$ENV_FILE" ] || [ ! -r "$ENV_FILE" ]; then
  fail "env file not found or unreadable: $ENV_FILE"
fi
ENV_FILE="$(cd -- "$(dirname -- "$ENV_FILE")" && pwd)/$(basename -- "$ENV_FILE")"
if [ ! -d "$OUTPUT_DIR" ]; then
  fail "output directory does not exist: $OUTPUT_DIR (create it first; this script never creates directories)"
fi
if [ ! -w "$OUTPUT_DIR" ]; then
  fail "output directory is not writable: $OUTPUT_DIR"
fi
OUTPUT_DIR="$(cd -- "$OUTPUT_DIR" && pwd)"
if [ "$OUTPUT_DIR" = "$REPO_ROOT" ] || [ "${OUTPUT_DIR#"$REPO_ROOT"/}" != "$OUTPUT_DIR" ]; then
  fail "refusing to write backup artifacts into the repository: $OUTPUT_DIR"
fi

# Read one value from the Compose .env file (KEY=VALUE lines; the compose
# CLI parses the full file for the containers). Only non-secret values
# needed for artifact naming are read here; the password is never read or
# printed by this script.
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
case "$POSTGRES_DB" in
  [A-Za-z_][A-Za-z0-9_]*) : ;;
  *) fail "POSTGRES_DB is not a plain (unquoted) PostgreSQL identifier; refusing to build an artifact name from it" ;;
esac
POSTGRES_USER="$(env_value POSTGRES_USER)"
case "$POSTGRES_USER" in
  [A-Za-z_][A-Za-z0-9_]*) : ;;
  *) fail "POSTGRES_USER is not a plain (unquoted) PostgreSQL identifier" ;;
esac

# --- Compose CLI with a reachable daemon ------------------------------------
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

# --- db service usability ----------------------------------------------------
if ! compose exec -T db sh -c 'exit 0' >/dev/null 2>&1; then
  fail "db service is not usable (container missing or not running). Start the stack first: ${COMPOSE_CLI[*]} -f deploy/compose.production.yaml up -d"
fi
if ! compose exec -T db pg_isready -q >/dev/null 2>&1; then
  fail "db service is not accepting connections yet (pg_isready failed)"
fi

# --- Artifact paths -----------------------------------------------------------
TS="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL_NAME="fg-workspace-${POSTGRES_DB}-${TS}.dump"
FINAL="$OUTPUT_DIR/$FINAL_NAME"
PARTIAL="${FINAL}.partial"
if [ -e "$FINAL" ]; then fail "final artifact already exists: $FINAL"; fi
if [ -e "$PARTIAL" ]; then fail "partial artifact already exists: $PARTIAL"; fi

STAGE=""
cleanup() {
  local rc=$?
  trap - EXIT
  if [ -n "$STAGE" ] && [ ${#COMPOSE_CLI[@]} -gt 0 ]; then
    compose exec -T db rm -f -- "$STAGE" >/dev/null 2>&1 || true
  fi
  if [ ! -f "$FINAL" ] && [ -n "$PARTIAL" ] && [ -e "$PARTIAL" ]; then
    rm -f -- "$PARTIAL"
    log "postgres-backup: removed partial artifact: $PARTIAL"
  fi
}
trap cleanup EXIT

log "postgres-backup: database='${POSTGRES_DB}' archive='${FINAL_NAME}'"

# --- Dump (live, custom format) ------------------------------------------------
log "postgres-backup: running pg_dump -Fc (database stays online)"
if ! compose exec -T db pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB" > "$PARTIAL"; then
  fail "pg_dump failed (see pg_dump output above)"
fi
if [ ! -s "$PARTIAL" ]; then
  fail "pg_dump produced an empty archive"
fi

# --- Validate the archive BEFORE publication ------------------------------------
STAGE="/tmp/fg-backup-validate-$$.dump"
log "postgres-backup: validating archive (pg_restore --list via db container)"
if ! compose exec -T db sh -c "cat > '$STAGE'" < "$PARTIAL"; then
  STAGE=""
  fail "staging the archive into the db container failed"
fi
if ! compose exec -T db pg_restore --list "$STAGE" >/dev/null 2>&1; then
  STAGE=""
  fail "archive validation failed: pg_restore --list rejected the archive"
fi
compose exec -T db rm -f -- "$STAGE" >/dev/null 2>&1 || true
STAGE=""

# --- Publish (atomic rename) -------------------------------------------------------
mv -- "$PARTIAL" "$FINAL"
PARTIAL=""
log "postgres-backup: published $FINAL"

# --- SHA-256 sidecar -----------------------------------------------------------------
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
if ! HASH="$(hash_of "$FINAL")"; then
  fail "no SHA-256 facility available on this host (sha256sum/shasum/openssl)"
fi
printf '%s  %s\n' "$HASH" "$FINAL_NAME" > "$FINAL.sha256"
if [ "$(hash_of "$FINAL")" != "$HASH" ]; then
  fail "checksum self-verification failed"
fi

log "postgres-backup: DONE"
log "  archive: $FINAL"
log "  sidecar: $FINAL.sha256"
log "  sha256:  $HASH"
log "  verify:  cd '$OUTPUT_DIR' && <host sha256 tool> -c '$FINAL_NAME.sha256' (e.g. 'sha256sum -c' or 'shasum -a 256 -c')"
