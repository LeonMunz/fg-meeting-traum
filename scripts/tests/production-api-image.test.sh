#!/usr/bin/env bash
#
# Runtime acceptance tests for the production API image
# (apps/api/Dockerfile, build context apps/api/).
#
# Run:  bash scripts/tests/production-api-image.test.sh
#
# Requires: bash, node, and a reachable Docker daemon. This is a RUNTIME
# test — it builds and runs the actual production image — unlike the
# static contract tests (publish-workflow, production-compose,
# release-transaction), which only read files. Without a Docker daemon it
# fails with an ENVIRONMENT/HARNESS classification and the exact
# host-side acceptance command; a source-level check (e.g. grepping for an
# app directory) is not a substitute for image acceptance.
#
# Coverage:
#   * the production API image builds; the Dockerfile's own build-time
#     packaging acceptance (Django initialization with
#     config.settings_production + loading of every INSTALLED_APPS entry)
#     is part of that build, so an image whose configured applications
#     cannot initialize can never be produced
#   * inside the built image, with safe test-only production environment
#     values: `import personal_notes` succeeds, `django.setup()`
#     succeeds, and `python manage.py check` succeeds — i.e. every
#     configured Django app is loadable in the real packaged image
#   * runtime security properties are preserved: non-root execution
#     (UID 10001), no test files and no .env files in /app, no build
#     tooling (uv) in the runtime stage, and the CMD remains the
#     Gunicorn startup contract (container startup never runs migrations)
#   * the guard is generic: a build context whose INSTALLED_APPS
#     registers an app that is not packaged must fail the build with a
#     ModuleNotFoundError — a pre-publication failure, not a runtime
#     surprise (this is the failure mode of the 4921cc3 release attempt)
#   * isolated disposable PostgreSQL 16 acceptance: the built image
#     applies every migration to a throwaway database (private Docker
#     network, no host port) and then both `python manage.py
#     migrate --check` and `python manage.py makemigrations --check
#     --dry-run` pass — no missing or drifted migrations in the image
#
# No production infrastructure, registry, or deployment is touched: the
# image is tagged locally and removed on exit, and the disposable
# PostgreSQL exists only on a private Docker network without a host port.

set -Eeuo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_CONTEXT="$REPO_ROOT/apps/api"
IMAGE_TAG="fg-api-personal-notes-packaging-test"
NEGATIVE_TAG="${IMAGE_TAG}:negative"
WORK=""
PG_CONTAINER=""
PG_NETWORK=""

cleanup() {
  if [ -n "$WORK" ]; then rm -rf -- "$WORK"; fi
  if [ -n "$PG_CONTAINER" ]; then docker rm -f -- "$PG_CONTAINER" >/dev/null 2>&1 || true; fi
  if [ -n "$PG_NETWORK" ]; then docker network rm -- "$PG_NETWORK" >/dev/null 2>&1 || true; fi
  docker rmi --quiet -- "$IMAGE_TAG" >/dev/null 2>&1 || true
  docker rmi --quiet -- "$NEGATIVE_TAG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  printf 'production-api-image tests: FAIL: %s\n' "$1" >&2
  exit 1
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/fg-production-api-image-tests.XXXXXX")"

# ------------------------------------------------------------ docker ------
command -v docker >/dev/null 2>&1 \
  || fail "no Docker CLI (ENVIRONMENT/HARNESS, not an image defect) — on a Docker-capable host start Docker and rerun: bash scripts/tests/production-api-image.test.sh"
docker info >/dev/null 2>&1 \
  || fail "no reachable Docker daemon (ENVIRONMENT/HARNESS, not an image defect) — start Docker and rerun: bash scripts/tests/production-api-image.test.sh"

# Safe test-only production environment values: config.settings_production
# requires these to be non-empty and well-formed only; none of them point
# at real infrastructure, and they are passed on the docker run command
# line — never baked into the image.
CHECK_ENV=(
  -e DJANGO_SECRET_KEY=fg-image-build-check-only
  -e POSTGRES_DB=build_check
  -e POSTGRES_USER=build_check
  -e POSTGRES_PASSWORD=build_check
  -e POSTGRES_HOST=127.0.0.1
  -e POSTGRES_PORT=5432
  -e DJANGO_ALLOWED_HOSTS=build-check.invalid
  -e DJANGO_CSRF_TRUSTED_ORIGINS=https://build-check.invalid
)

# in_image <label> <command...> — run a command inside the built image
# with the safe test-only production environment.
in_image() {
  local label="$1"
  shift
  printf '== %s\n' "$label"
  docker run --rm "${CHECK_ENV[@]}" "$IMAGE_TAG" "$@" \
    || fail "$label (see docker output above)"
}

# ----------------------------------------------------- positive image -----
printf '== building the production API image (%s)\n' "$IMAGE_TAG"
docker build \
  -f "$BUILD_CONTEXT/Dockerfile" -t "$IMAGE_TAG" "$BUILD_CONTEXT" \
  > "$WORK/build.log" 2>&1 \
  || { cat "$WORK/build.log" >&2; fail "production API image build failed — while any configured Django app cannot initialize inside the image, the image must not be producible (and therefore not publishable)"; }

in_image "import personal_notes (from the real packaged image)" \
  python -c "import personal_notes"
in_image "django.setup() with config.settings_production (every INSTALLED_APPS entry loads)" \
  python -c "import django; django.setup()"
in_image "python manage.py check" python manage.py check

# ------------------------------------------------- security properties ----
uid="$(docker run --rm "$IMAGE_TAG" id -u)"
[ "$uid" = "10001" ] || fail "runtime image is not UID 10001 (got: $uid)"
printf 'ok   runtime user is non-root (uid %s)\n' "$uid"

test_files="$(docker run --rm "$IMAGE_TAG" sh -c "find /app -name 'test*.py' -o -name 'tests*.py' | wc -l" | tr -d '[:space:]')"
[ "$test_files" = "0" ] || fail "test files were copied into /app of the runtime image"
printf 'ok   no test files in /app of the runtime image\n'

env_files="$(docker run --rm "$IMAGE_TAG" sh -c "find /app -name '.env' -o -name '.env.*' | wc -l" | tr -d '[:space:]')"
[ "$env_files" = "0" ] || fail ".env files were copied into /app of the runtime image"
printf 'ok   no .env files in /app of the runtime image\n'

if docker run --rm "$IMAGE_TAG" sh -c "command -v uv" >/dev/null 2>&1; then
  fail "build tooling (uv) is present in the runtime stage"
fi
printf 'ok   no build tooling (uv) in the runtime stage\n'

cmd_json="$(docker inspect --format '{{json .Config.Cmd}}' "$IMAGE_TAG")"
case "$cmd_json" in
  *gunicorn*config.wsgi:application*) ;;
  *) fail "CMD is no longer the Gunicorn startup contract: $cmd_json" ;;
esac
case "$cmd_json" in
  *migrate*) fail "container startup must not run migrations: $cmd_json" ;;
esac
entry_json="$(docker inspect --format '{{json .Config.Entrypoint}}' "$IMAGE_TAG")"
case "$entry_json" in
  *migrate*) fail "container entrypoint must not run migrations: $entry_json" ;;
esac
printf 'ok   CMD remains the Gunicorn startup contract (no automatic migrations)\n'

# --------------------------------------------- generic guard (negative) ---
printf '== negative control: an INSTALLED_APPS entry that is not packaged must fail the build\n'
NEG_CONTEXT="$WORK/negative-context"
cp -R -- "$BUILD_CONTEXT" "$NEG_CONTEXT"
rm -rf -- "$NEG_CONTEXT/.venv"
find "$NEG_CONTEXT" -type d -name '__pycache__' -prune -exec rm -rf -- {} +

# Register a probe app that does not exist anywhere: if the packaging
# guard is effective, the build must fail with a ModuleNotFoundError for
# it BEFORE any image is produced (the generic form of the 4921cc3
# personal_notes omission).
node - "$NEG_CONTEXT/config/settings.py" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const source = fs.readFileSync(path, "utf8");
const patched = source.replace(
  /^(INSTALLED_APPS = \[\n)/m,
  "$1    'zz_packaging_guard_probe',\n"
);
if (patched === source) {
  console.error("injection point (INSTALLED_APPS = [) not found");
  process.exit(1);
}
fs.writeFileSync(path, patched);
NODE

if docker build \
  -f "$BUILD_CONTEXT/Dockerfile" -t "$NEGATIVE_TAG" "$NEG_CONTEXT" \
  > "$WORK/negative-build.log" 2>&1; then
  cat "$WORK/negative-build.log" >&2
  fail "negative build unexpectedly succeeded — the build-time packaging guard is missing or ineffective"
fi
grep -q "No module named 'zz_packaging_guard_probe'" "$WORK/negative-build.log" \
  || { cat "$WORK/negative-build.log" >&2; fail "negative build failed, but not with the expected ModuleNotFoundError for the un-packaged app"; }
printf 'ok   un-packaged INSTALLED_APPS entry fails the build pre-publication (ModuleNotFoundError)\n'

# ---------------------------------- isolated PostgreSQL migration check ---
printf '== isolated disposable PostgreSQL 16 migration acceptance\n'
PG_NETWORK="fg-api-packaging-net-$$"
PG_CONTAINER="fg-api-packaging-pg-$$"

docker network create -- "$PG_NETWORK" >/dev/null
docker run -d --name "$PG_CONTAINER" --network "$PG_NETWORK" \
  -e POSTGRES_USER=fg_packaging_check \
  -e POSTGRES_PASSWORD=fg_packaging_check \
  -e POSTGRES_DB=fg_packaging_check \
  postgres:16 >/dev/null \
  || fail "could not start the disposable PostgreSQL 16 container"

PG_ENV=(
  -e DJANGO_SECRET_KEY=fg-image-build-check-only
  -e POSTGRES_DB=fg_packaging_check
  -e POSTGRES_USER=fg_packaging_check
  -e POSTGRES_PASSWORD=fg_packaging_check
  -e POSTGRES_HOST="$PG_CONTAINER"
  -e POSTGRES_PORT=5432
  -e DJANGO_ALLOWED_HOSTS=build-check.invalid
  -e DJANGO_CSRF_TRUSTED_ORIGINS=https://build-check.invalid
)

ready=0
for _ in $(seq 1 60); do
  if docker exec -- "$PG_CONTAINER" pg_isready -U fg_packaging_check -d fg_packaging_check >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = "1" ] || fail "disposable PostgreSQL did not become ready within 60s"

# pg_in_image <label> <command...> — run a command in the built image on
# the disposable PostgreSQL network.
pg_in_image() {
  local label="$1"
  shift
  printf '== %s\n' "$label"
  docker run --rm --network "$PG_NETWORK" "${PG_ENV[@]}" "$IMAGE_TAG" "$@" \
    || fail "$label (see docker output above)"
}

pg_in_image "python manage.py migrate --noinput (isolated disposable database)" \
  python manage.py migrate --noinput
pg_in_image "python manage.py migrate --check" python manage.py migrate --check
pg_in_image "python manage.py makemigrations --check --dry-run (no model drift in the packaged image)" \
  python manage.py makemigrations --check --dry-run

# ---------------------------------------------------------------- done ----
printf '\nproduction-api-image tests: PASS\n'
printf '  image build (build-time packaging acceptance inside the Dockerfile)\n'
printf '  in-image: import personal_notes, django.setup(), manage.py check (production settings, safe test-only env)\n'
printf '  security: uid 10001, no tests/.env in /app, no uv in runtime, Gunicorn CMD contract\n'
printf '  negative guard: un-packaged app fails the build pre-publication\n'
printf '  isolated PostgreSQL: migrate + migrate --check + makemigrations --check\n'
