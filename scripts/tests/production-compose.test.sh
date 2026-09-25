#!/usr/bin/env bash
# Rendered-contract tests for deploy/compose.production.yaml.
# No Docker daemon, images, registry, network, or production secrets are used.

set -Eeuo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/deploy/compose.production.yaml"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif docker-compose version >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  printf 'FAIL production Compose contract: no Compose CLI available\n' >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/fg-production-compose-tests.XXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT

env \
  FG_WEB_IMAGE=example.invalid/fg-web:test \
  FG_API_IMAGE=example.invalid/fg-api:test \
  FG_POSTGRES_DATA_VOLUME=fg_test_pg16_data \
  POSTGRES_DB=fg \
  POSTGRES_USER=fg \
  POSTGRES_PASSWORD=test-password \
  DJANGO_SECRET_KEY=test-secret \
  DJANGO_ALLOWED_HOSTS=127.0.0.1 \
  DJANGO_CSRF_TRUSTED_ORIGINS=https://127.0.0.1:8080 \
  "${COMPOSE[@]}" --project-directory "$REPO_ROOT/deploy" \
    -f "$COMPOSE_FILE" config --format json > "$WORK/config.json"

node - "$WORK/config.json" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
assert.deepEqual(Object.keys(config.services).sort(), ["api", "db", "web"]);

for (const service of ["web", "api", "db"]) {
  assert.equal(config.services[service].restart, "unless-stopped");
}

assert.deepEqual(config.services.web.networks, {gateway: null});
assert.deepEqual(config.services.api.networks, {data: null, gateway: null});
assert.deepEqual(config.services.db.networks, {data: null});
assert.equal(config.networks.data.internal, true);

assert.equal(config.services.web.ports.length, 1);
assert.deepEqual(config.services.web.ports[0], {
  mode: "ingress",
  host_ip: "127.0.0.1",
  target: 8080,
  published: "8080",
  protocol: "tcp",
});
assert.equal(config.services.api.ports, undefined);
assert.equal(config.services.db.ports, undefined);

assert.equal(config.volumes["postgres-data"].external, true);
assert.equal(config.volumes["postgres-data"].name, "fg_test_pg16_data");
assert.equal(config.services.api.command, null);
assert.equal(config.services.db.command, null);
assert.equal(config.services.web.command, null);

console.log("production Compose contract: PASS");
NODE
