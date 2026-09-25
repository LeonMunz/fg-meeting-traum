#!/usr/bin/env bash
#
# FG Workspace — manual exact-SHA production release transaction.
#
# One fail-closed operator command for a FULL 40-character commit SHA.
# It releases the production Compose topology (deploy/compose.production.yaml)
# to the exact published image pair by orchestrating EXISTING primitives
# only: the production Compose file, deploy/scripts/postgres-backup.sh,
# and the /api/health/ endpoint.
#
# Guarantees:
#   * fail closed: every phase failure exits non-zero and prevents all
#     later phases;
#   * immutable identity: only the exact <base>-api:<sha> /
#     <base>-web:<sha> full-SHA image references are ever used;
#   * no automation: NO automatic restore, NO automatic rollback, no
#     automatic retry, and no destructive container or volume command.
#
# Phase order:
#   VALIDATION     release identity + inputs, before any runtime mutation
#   COMPOSE_CONFIG production Compose configuration validated with the
#                  derived full-SHA image references (no image fetch, no
#                  containers)
#   BACKUP         predeploy backup via deploy/scripts/postgres-backup.sh
#                  (that script remains authoritative for dump validation,
#                  checksum, and atomic publication)
#   IMAGE_PULL     pull ONLY the exact full-SHA api + web images
#   MIGRATION      exactly one `manage.py migrate` from the NEW api image
#                  (one-shot container, never the running old container),
#                  then `manage.py migrate --check` from the same image
#   STACK_UPDATE   update only the api + web services
#   HEALTH         service state, same-origin /api/health/ liveness through
#                  the web gateway, gateway / smoke, schema readiness
#
# Failure semantics (fail closed; recovery is a manual operator decision):
#   * A failed migration is NOT assumed retry-safe: it may be non-atomic,
#     irreversible, or have external side effects. The release stops
#     immediately, reports that the database MAY HAVE CHANGED, that
#     operator investigation/recovery is REQUIRED, and identifies the
#     predeploy backup as the recovery artifact.
#   * A failed `migrate --check` prevents the stack update.
#   * A failed stack update happens AFTER the database is already
#     migrated; operator intervention may be necessary.
#
# Host requirements: bash, curl, the Docker CLI, and the Compose CLI
# (repository convention: docker compose preferred, docker-compose fallback).
# No other dependencies are introduced.
#
# Operational procedure: docs/living-lab.md (Manual exact-SHA release).

set -Eeuo pipefail

log()   { printf '%s\n' "$*" >&2; }
fail()  { log "release: ERROR: phase=$1 $2"; exit 1; }
phase() { log "release: phase=$1"; }

usage() {
  cat >&2 <<'USAGE'
Usage: release.sh <FULL_SHA> \
       --env-file <path> --image-base <registry/repository-base> \
       --backup-dir <existing-backup-directory> [--project-name <name>]

  <FULL_SHA>            The release identity: exactly 40 lowercase hex
                        characters (a full Git commit SHA). Short SHAs,
                        branch names, and mutable tags are rejected.
  --env-file <path>     Compose .env file for deploy/compose.production.yaml.
                        Default: <repo>/deploy/.env
  --image-base <base>   Registry/repository base of the published images,
                        e.g. ghcr.io/<owner>/<repo>. The release pulls
                        <base>-api:<FULL_SHA> and <base>-web:<FULL_SHA>.
  --backup-dir <path>   EXISTING directory, OUTSIDE the repository, where
                        the predeploy backup archive is written.
  --project-name <name> Compose project name of the running stack.
                        Default: the project declared in the Compose file
                        (fg-production).

Phase order: VALIDATION -> COMPOSE_CONFIG -> BACKUP -> IMAGE_PULL ->
MIGRATION -> STACK_UPDATE -> HEALTH.
Every phase failure exits non-zero and prevents all later phases.
There is NO automatic restore and NO automatic rollback of any kind.
Operational procedure: docs/living-lab.md (Manual exact-SHA release).
USAGE
}

# --- Argument parsing ---------------------------------------------------------
SHA=""
ENV_FILE=""
IMAGE_BASE=""
BACKUP_DIR=""
PROJECT_NAME=""
POSITIONAL=()
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file)     if [ $# -lt 2 ]; then usage; exit 2; fi; ENV_FILE="$2"; shift 2 ;;
    --image-base)   if [ $# -lt 2 ]; then usage; exit 2; fi; IMAGE_BASE="$2"; shift 2 ;;
    --backup-dir)   if [ $# -lt 2 ]; then usage; exit 2; fi; BACKUP_DIR="$2"; shift 2 ;;
    --project-name) if [ $# -lt 2 ]; then usage; exit 2; fi; PROJECT_NAME="$2"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    --)             shift; while [ $# -gt 0 ]; do POSITIONAL+=("$1"); shift; done ;;
    -*)             usage; exit 2 ;;
    *)              POSITIONAL+=("$1"); shift ;;
  esac
done
[ ${#POSITIONAL[@]} -eq 1 ] || { usage; exit 2; }
SHA="${POSITIONAL[0]}"

# --- Resolve repository / Compose file (caller-CWD independent) ---------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/deploy/compose.production.yaml"
BACKUP_SCRIPT="$REPO_ROOT/deploy/scripts/postgres-backup.sh"
if [ ! -f "$COMPOSE_FILE" ]; then
  log "release: ERROR: phase=VALIDATION Compose file not found: $COMPOSE_FILE"
  exit 1
fi
if [ ! -x "$BACKUP_SCRIPT" ]; then
  log "release: ERROR: phase=VALIDATION backup script missing or not executable: $BACKUP_SCRIPT"
  exit 1
fi

# --- Phase: VALIDATION (before any runtime mutation) ---------------------------
phase VALIDATION

# Release identity: exactly 40 lowercase hex characters — a full commit SHA.
# Rejects short SHAs, branch names, mutable tags, uppercase, and malformed
# input (39/41 characters, non-hex characters).
if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  fail VALIDATION "invalid release SHA '$SHA': expected exactly 40 lowercase hex characters (a full commit SHA)"
fi

if [ -z "$IMAGE_BASE" ]; then
  fail VALIDATION "--image-base is required (registry/repository base, e.g. ghcr.io/<owner>/<repo>)"
fi
case "$IMAGE_BASE" in
  *[[:space:]]*) fail VALIDATION "--image-base must not contain whitespace" ;;
  *@*)           fail VALIDATION "--image-base must not carry a digest" ;;
esac
case "$IMAGE_BASE" in
  */*) : ;;
  *) fail VALIDATION "--image-base must be a registry/repository base (e.g. ghcr.io/<owner>/<repo>)" ;;
esac
BASE_FINAL="${IMAGE_BASE##*/}"
case "$BASE_FINAL" in
  ""|*:*) fail VALIDATION "--image-base must not be empty or carry a tag on its final segment: $IMAGE_BASE" ;;
esac

if [ -z "$BACKUP_DIR" ]; then
  fail VALIDATION "--backup-dir is required (existing directory outside the repository)"
fi
if [ ! -d "$BACKUP_DIR" ]; then
  fail VALIDATION "backup directory does not exist: $BACKUP_DIR"
fi

# Repository convention: the Compose project directory's .env.
if [ -z "$ENV_FILE" ]; then ENV_FILE="$REPO_ROOT/deploy/.env"; fi
if [ ! -f "$ENV_FILE" ] || [ ! -r "$ENV_FILE" ]; then
  fail VALIDATION "env file not found or unreadable: $ENV_FILE (default is deploy/.env; pass --env-file explicitly)"
fi

command -v curl >/dev/null 2>&1 || fail VALIDATION "curl is required (HEALTH phase) but was not found on this host"

# Derived immutable image references — the identical SHA for both services.
API_IMAGE="${IMAGE_BASE}-api:${SHA}"
WEB_IMAGE="${IMAGE_BASE}-web:${SHA}"
log "release: sha=$SHA api=$API_IMAGE web=$WEB_IMAGE"

# Every later Compose operation must resolve the DERIVED full-SHA images.
# Compose gives actual environment variables precedence over --env-file.
export FG_API_IMAGE="$API_IMAGE"
export FG_WEB_IMAGE="$WEB_IMAGE"

# --- Phase: COMPOSE_CONFIG ------------------------------------------------------
phase COMPOSE_CONFIG

# Compose CLI detection (repository convention: prefer 'docker compose',
# fall back to 'docker-compose').
COMPOSE_CLI=()
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CLI=(docker compose)
elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
  COMPOSE_CLI=(docker-compose)
else
  fail COMPOSE_CONFIG "no usable Compose CLI with a reachable Docker daemon (tried 'docker compose' and 'docker-compose')"
fi
command -v docker >/dev/null 2>&1 || fail COMPOSE_CONFIG "Docker CLI is required for container state inspection but was not found on this host"

if [ -n "$PROJECT_NAME" ]; then
  compose() {
    "${COMPOSE_CLI[@]}" -f "$COMPOSE_FILE" --project-directory "$REPO_ROOT/deploy" --env-file "$ENV_FILE" --project-name "$PROJECT_NAME" "$@"
  }
else
  compose() {
    "${COMPOSE_CLI[@]}" -f "$COMPOSE_FILE" --project-directory "$REPO_ROOT/deploy" --env-file "$ENV_FILE" "$@"
  }
fi

# Validate production Compose interpolation/configuration with the derived
# full-SHA image references BEFORE any backup. No image is fetched and no
# container is created in this phase.
if ! compose config --quiet; then
  fail COMPOSE_CONFIG "Compose configuration/interpolation is invalid for $API_IMAGE / $WEB_IMAGE; no backup, pull, migration, or stack update was performed"
fi

# --- Phase: BACKUP -----------------------------------------------------------------
phase BACKUP
BACKUP_ARGS=(--env-file "$ENV_FILE" --output-dir "$BACKUP_DIR")
if [ -n "$PROJECT_NAME" ]; then BACKUP_ARGS+=(--project-name "$PROJECT_NAME"); fi
BACKUP_RC=0
BACKUP_OUT="$("$BACKUP_SCRIPT" "${BACKUP_ARGS[@]}" 2>&1)" || BACKUP_RC=$?
if [ "$BACKUP_RC" -ne 0 ]; then
  printf '%s\n' "$BACKUP_OUT" >&2
  fail BACKUP "predeploy backup failed (exit $BACKUP_RC); no image pull, migration, or stack update was performed"
fi
printf '%s\n' "$BACKUP_OUT" >&2
BACKUP_ARCHIVE="$(printf '%s\n' "$BACKUP_OUT" | sed -n 's/^ *archive: //p' | tail -n 1)"
if [ -z "$BACKUP_ARCHIVE" ]; then
  fail BACKUP "backup succeeded but the archive path could not be determined from its output"
fi
log "release: predeploy backup published: $BACKUP_ARCHIVE"

# --- Phase: IMAGE_PULL -----------------------------------------------------------------
phase IMAGE_PULL
log "release: pulling exact images: $API_IMAGE, $WEB_IMAGE"
if ! compose pull api web; then
  fail IMAGE_PULL "pulling the exact images failed; the currently running stack and the database are unchanged"
fi

# --- Phase: MIGRATION -------------------------------------------------------------------
phase MIGRATION
log "release: running exactly one migration from the NEW api image (one-shot container)"
if ! compose run --rm --no-deps api python manage.py migrate --noinput; then
  log "release: the migration FAILED. The database MAY HAVE CHANGED; a failed migration is NOT assumed retry-safe (it may be non-atomic, irreversible, or have external side effects)."
  log "release: operator investigation and recovery are REQUIRED. No automatic retry, restore, or rollback was performed."
  log "release: the predeploy backup is the recovery artifact: $BACKUP_ARCHIVE"
  fail MIGRATION "manage.py migrate failed from the new api image; the stack was NOT updated"
fi
if ! compose run --rm --no-deps api python manage.py migrate --check; then
  log "release: the stack was NOT updated. The database already carries whatever the migration applied; operator investigation is REQUIRED. Recovery artifact: $BACKUP_ARCHIVE"
  fail MIGRATION "manage.py migrate --check failed: unapplied or inconsistent migrations remain; the stack was NOT updated"
fi
log "release: migration complete; migrate --check is clean"

# --- Phase: STACK_UPDATE --------------------------------------------------------------------
phase STACK_UPDATE
log "release: updating only the api + web services"
if ! compose up -d --no-deps api web; then
  log "release: the database has ALREADY BEEN MIGRATED; operator intervention may be necessary. No automatic rollback was performed."
  fail STACK_UPDATE "updating the api/web services failed"
fi

# --- Phase: HEALTH ------------------------------------------------------------------------------
phase HEALTH

# One bounded retry budget is used independently for container readiness and
# same-origin API liveness. Invalid overrides fall back to the defaults.
ATTEMPTS="${FG_RELEASE_HEALTH_ATTEMPTS:-15}"
DELAY="${FG_RELEASE_HEALTH_DELAY_SECONDS:-4}"
case "$ATTEMPTS" in *[!0-9]*|"") ATTEMPTS=15 ;; esac
case "$DELAY" in *[!0-9]*|"") DELAY=4 ;; esac

# (a) Service state: api, web, and db must each have exactly one container,
# that container must be running, and a configured healthcheck must report
# healthy within the bounded readiness window. Include stopped containers so
# Docker can report their real state. Missing, duplicate, stopped, unhealthy,
# and unexpected states fail immediately; only `starting` is retried.
API_CONTAINER_ID=""
WEB_CONTAINER_ID=""
READINESS_OK=0
STARTING_SERVICES=""
attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  ALL_SERVICES_READY=1
  STARTING_SERVICES=""
  for svc in api web db; do
    CONTAINER_IDS="$(compose ps --all --quiet "$svc" 2>/dev/null)" || fail HEALTH "compose ps failed for service '$svc'"
    if [ -z "$CONTAINER_IDS" ]; then
      fail HEALTH "service '$svc' has no container"
    fi
    set -- $CONTAINER_IDS
    if [ "$#" -ne 1 ]; then
      fail HEALTH "service '$svc' has $# containers; expected exactly one"
    fi
    CONTAINER_ID="$1"
    STATE_INFO="$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CONTAINER_ID" 2>/dev/null)" \
      || fail HEALTH "could not inspect container state for service '$svc' ($CONTAINER_ID)"
    CONTAINER_STATUS="${STATE_INFO%%|*}"
    HEALTH_STATUS="${STATE_INFO#*|}"
    if [ "$CONTAINER_STATUS" != "running" ]; then
      fail HEALTH "service '$svc' container is not running (status: ${CONTAINER_STATUS:-unknown})"
    fi
    case "$HEALTH_STATUS" in
      ""|healthy) ;;
      starting)
        ALL_SERVICES_READY=0
        STARTING_SERVICES="${STARTING_SERVICES}${STARTING_SERVICES:+, }$svc"
        ;;
      unhealthy)
        fail HEALTH "service '$svc' container health is 'unhealthy' (expected healthy)"
        ;;
      *)
        fail HEALTH "service '$svc' container health is '$HEALTH_STATUS' (unexpected status)"
        ;;
    esac
    case "$svc" in
      api) API_CONTAINER_ID="$CONTAINER_ID" ;;
      web) WEB_CONTAINER_ID="$CONTAINER_ID" ;;
    esac
  done
  if [ "$ALL_SERVICES_READY" -eq 1 ]; then
    READINESS_OK=1
    break
  fi
  if [ "$attempt" -lt "$ATTEMPTS" ] && [ "$DELAY" -gt 0 ]; then sleep "$DELAY"; fi
  attempt=$((attempt + 1))
done
if [ "$READINESS_OK" -ne 1 ]; then
  fail HEALTH "container readiness timed out after $ATTEMPTS attempts; health still starting: $STARTING_SERVICES"
fi

# (b)+(c) Same-origin liveness + gateway smoke through the web gateway, on the
# Compose-reported published port (never hardcoded, never parsed from .env).
HOSTPORT="$(compose port web 8080 2>/dev/null | tail -n 1)" || fail HEALTH "compose port web 8080 failed"
case "$HOSTPORT" in
  "") fail HEALTH "compose port web 8080 returned no published port" ;;
esac
HP_HOST=""
HP_PORT=""
if [[ "$HOSTPORT" =~ ^\[([0-9A-Fa-f:]+)\]:([0-9]+)$ ]]; then
  HP_HOST="${BASH_REMATCH[1]}"
  HP_PORT="${BASH_REMATCH[2]}"
elif [[ "$HOSTPORT" =~ ^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):([0-9]+)$ ]]; then
  HP_HOST="${BASH_REMATCH[1]}"
  HP_PORT="${BASH_REMATCH[2]}"
  IFS=. read -r IP1 IP2 IP3 IP4 <<< "$HP_HOST"
  for octet in "$IP1" "$IP2" "$IP3" "$IP4"; do
    if [ "$octet" -gt 255 ]; then
      fail HEALTH "compose port web 8080 returned an invalid IPv4 mapping: $HOSTPORT"
    fi
  done
elif [[ "$HOSTPORT" =~ ^([0-9A-Fa-f:]*:[0-9A-Fa-f:]*):([0-9]+)$ ]]; then
  HP_HOST="${BASH_REMATCH[1]}"
  HP_PORT="${BASH_REMATCH[2]}"
  case "$HP_HOST" in
    ""|":"|*:::*) fail HEALTH "compose port web 8080 returned an invalid IPv6 mapping: $HOSTPORT" ;;
  esac
else
  fail HEALTH "compose port web 8080 returned an unexpected mapping: $HOSTPORT"
fi
if [ "$HP_PORT" -lt 1 ] || [ "$HP_PORT" -gt 65535 ]; then
  fail HEALTH "compose port web 8080 returned an invalid port: $HOSTPORT"
fi
case "$HP_HOST" in
  0.0.0.0) HP_HOST="127.0.0.1" ;;
  ::)      HP_HOST="::1" ;;
esac
case "$HP_HOST" in
  *:*) BASE_URL="http://[${HP_HOST}]:${HP_PORT}/" ;;
  *)   BASE_URL="http://${HP_HOST}:${HP_PORT}/" ;;
esac

# Bounded liveness retry after container readiness has succeeded.
HEALTH_OK=0
attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  if HEALTH_BODY="$(curl -fsS --max-time 5 "${BASE_URL}api/health/" 2>/dev/null)" \
     && printf '%s' "$HEALTH_BODY" | tr -d ' \n\t' | grep -q '"status":"ok"'; then
    HEALTH_OK=1
    break
  fi
  if [ "$attempt" -lt "$ATTEMPTS" ] && [ "$DELAY" -gt 0 ]; then sleep "$DELAY"; fi
  attempt=$((attempt + 1))
done
if [ "$HEALTH_OK" -ne 1 ]; then
  fail HEALTH "same-origin API liveness failed: GET ${BASE_URL}api/health/ did not return the successful health response (liveness only; not database correctness)"
fi
log "release: liveness ok: GET ${BASE_URL}api/health/ -> $(printf '%s' "$HEALTH_BODY" | tr -d '\n')"

if ! curl -fsS --max-time 10 "${BASE_URL}" -o /dev/null; then
  fail HEALTH "gateway smoke failed: GET ${BASE_URL} did not return a successful response"
fi
log "release: gateway smoke ok: GET ${BASE_URL}"

# (d) Schema readiness: the release's `manage.py migrate --check` already
# succeeded in the MIGRATION phase (same new-image contract, same database);
# it is reported, not re-executed (exactly one real migrate per release).

# Advisory: verify org.opencontainers.image.revision on the running
# application containers using existing Docker metadata only. Never fails
# the release (locally built test images may lack the OCI label).
REV_MATCHES=0
for CONTAINER_ID in "$API_CONTAINER_ID" "$WEB_CONTAINER_ID"; do
  if REVISION="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$CONTAINER_ID" 2>/dev/null)"; then
    if [ "$REVISION" = "$SHA" ]; then
      REV_MATCHES=$((REV_MATCHES + 1))
    fi
  fi
done
if [ "$REV_MATCHES" -ge 2 ]; then
  REV_NOTE="org.opencontainers.image.revision matches $SHA on both running api and web containers"
elif [ "$REV_MATCHES" -eq 1 ]; then
  REV_NOTE="org.opencontainers.image.revision matches $SHA on only one of the two application containers (advisory)"
else
  REV_NOTE="org.opencontainers.image.revision does not match $SHA (advisory only; locally built test images may lack the OCI label)"
fi

# --- Success report -----------------------------------------------------------------------------
log ""
log "release: RELEASE SUCCESS"
log "  requested SHA:   $SHA"
log "  api image:       $API_IMAGE"
log "  web image:       $WEB_IMAGE"
log "  backup:          ok (predeploy) — $BACKUP_ARCHIVE (+ .sha256 sidecar)"
log "  migration:       ok — exactly one manage.py migrate from the new api image; migrate --check clean"
log "  health:          ok — GET ${BASE_URL}api/health/ via the web gateway (liveness only)"
log "  smoke:           ok — GET ${BASE_URL} served successfully"
log "  schema:          ready — manage.py migrate --check passed (MIGRATION phase)"
log "  revision label:  $REV_NOTE"
log "  gateway:         $BASE_URL"
exit 0
