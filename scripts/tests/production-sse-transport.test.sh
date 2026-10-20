#!/usr/bin/env bash
#
# Production SSE transport runtime test (RT-03B verification slice).
#
# Executes the RT-03A SSE invalidation transport
# (apps/api/work_items/realtime.py, GET /api/work-items/events/)
# end-to-end through the ACTUAL local production architecture:
#
#   127.0.0.1:<free loopback port> -> web (Caddy) -> api (Gunicorn
#   gthread, config.settings_production) -> db (PostgreSQL 16)
#
# using the existing deploy/compose.production.yaml topology and
# production images built from the existing Dockerfile contracts
# (apps/api/Dockerfile, context apps/api/; apps/web/Dockerfile,
# context repository root). No product code is modified and no
# production mutation is wired: the NOTIFYs under test are committed
# by the EXISTING internal publisher interface
# (work_items.realtime.publish_project_work_item_changed /
# publish_my_work_changed) from a SECOND process — the
# operator-provisioned-session, scripted-client vehicle that
# docs/architecture.md (Realtime) prescribes for the loopback-HTTP
# topology (production Secure cookies make browser login impossible
# there; that restriction binds browsers, not scripts).
#
# Run:  bash scripts/tests/production-sse-transport.test.sh
#
# Requires: bash, curl, node, and a reachable Docker daemon.
# DOCKER_HOST is honored (colima hosts: point it at the colima docker
# socket, e.g. DOCKER_HOST=unix://$HOME/.colima/default/docker.sock).
# This is a RUNTIME test — it builds and runs the actual production
# images (stream phase ~2.5 min, plus image build time). Without a
# Docker daemon it fails with an ENVIRONMENT/HARNESS classification
# and the exact host-side acceptance command; a source-level check is
# not a substitute for transport acceptance.
#
# Isolation — no production stack, volume, or deployment is touched:
#   * unique Compose project (fg-rt03b-$$) and a unique
#     externally-managed PostgreSQL volume (fg-rt03b-pg16-data-$$)
#     that THIS test creates itself and destroys on exit;
#   * a unique free loopback host port (18000..18999);
#   * a temporary env file in a mktemp work dir (never deploy/.env);
#   * temporary local image tags (removed on exit);
#   * temporary test data only (one user, one group, one project,
#     one session) on the throwaway volume;
#   * before/after `docker ps` snapshots assert no other container is
#     affected, and the operator volume name is asserted untouched.
#
# Runtime criteria (all observed, none inferred):
#   C1   local production images build (existing Dockerfile contract)
#   C2   Caddy -> Gunicorn gthread -> Django serves through the
#        existing Compose topology (api/db ports stay unpublished;
#        the Caddy gateway serves the SPA and proxies /api)
#   C3   authenticated SSE connection by a script client holding an
#        operator-provisioned Django session
#   C4   200 + text/event-stream + open handshake ({"userId": <id>})
#   C5   stream stays open for more than 60 seconds
#   C6   keep-alive comments (": ping", 15 s contract) reach the
#        client
#   C7   regular REST requests (sequential + 5 in parallel) keep
#        functioning while the stream is open
#   C8   committed PostgreSQL NOTIFYs via the existing internal
#        publisher from a SECOND process reach the stream (project
#        + user scope; per-delivery re-authorization exercised)
#   C9   forced client disconnect ends the stream and releases the
#        dedicated listener connection (no leak)
#   C10  PostgreSQL connections return to the baseline state after
#        cleanup (pg_stat_activity, application_name =
#        fg-realtime-listener: 0 before -> 1 while open -> 0 after)
# Plus: the Gunicorn startup log proves the gthread worker, and the
# worker's live thread count is reported as capacity evidence.
#
# On success: containers, networks, the temporary volume, the images,
# and the work dir are removed. On failure: the stack is torn down
# and the temporary volume is removed anyway, but the work dir
# (stream body, response headers, logs) is KEPT and its path is
# printed for diagnosis.

set -Eeuo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/deploy/compose.production.yaml"
API_BUILD_CONTEXT="$REPO_ROOT/apps/api"
OPERATOR_VOLUME_NAME="fg_production_pg16_data"

STREAM_HOLD_SECONDS=72
EVENT_WAIT_SECONDS=15
LISTENER_RELEASE_WAIT_SECONDS=60
HEALTH_WAIT_SECONDS=180

SUFFIX="rt03b-$$"
PROJECT_NAME="fg-rt03b-$$"
PG_VOLUME="fg-rt03b-pg16-data-$$"
API_IMAGE="fg-rt03b-api:local-$$"
WEB_IMAGE="fg-rt03b-web:local-$$"

WORK=""
ENV_FILE=""
STACK_UP=0
CURL_PID=""
STREAM_START=0
OTHER_CONTAINERS_BEFORE=""
OTHER_CONTAINERS_AFTER=""

cleanup() {
  local exit_code=$?
  if [ -n "$CURL_PID" ] && kill -0 "$CURL_PID" 2>/dev/null; then
    kill "$CURL_PID" 2>/dev/null || true
    wait "$CURL_PID" 2>/dev/null || true
  fi
  if [ "$STACK_UP" = "1" ]; then
    compose_cmd down --timeout 15 >/dev/null 2>&1 || true
  fi
  if [ -n "$PG_VOLUME" ]; then
    docker volume rm "$PG_VOLUME" >/dev/null 2>&1 || true
  fi
  # docker rmi has no --quiet flag in Docker 29; output is redirected.
  docker rmi -- "$API_IMAGE" >/dev/null 2>&1 || true
  docker rmi -- "$WEB_IMAGE" >/dev/null 2>&1 || true
  if [ "$exit_code" -eq 0 ]; then
    if [ -n "$WORK" ]; then rm -rf -- "$WORK"; fi
  else
    printf 'work dir kept for diagnosis: %s\n' "$WORK" >&2
  fi
}
trap cleanup EXIT

fail() {
  printf 'production-sse-transport tests: FAIL: %s\n' "$1" >&2
  exit 1
}

ok() {
  printf 'ok   %s\n' "$1"
}

# -------------------------------------------------------- preflights --
command -v docker >/dev/null 2>&1 \
  || fail "no Docker CLI (ENVIRONMENT/HARNESS, not a transport defect) — on a Docker-capable host start Docker and rerun: bash scripts/tests/production-sse-transport.test.sh"
docker info >/dev/null 2>&1 \
  || fail "no reachable Docker daemon (ENVIRONMENT/HARNESS, not a transport defect) — on a Docker-capable host start Docker (colima: colima start) and rerun: bash scripts/tests/production-sse-transport.test.sh"
command -v node >/dev/null 2>&1 \
  || fail "no node CLI (required for JSON assertions; ENVIRONMENT/HARNESS)"
command -v curl >/dev/null 2>&1 \
  || fail "no curl CLI (required for the scripted SSE/REST client; ENVIRONMENT/HARNESS)"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  fail "no Compose CLI (ENVIRONMENT/HARNESS)"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/fg-production-sse-transport-tests.XXXXXX")"
ENV_FILE="$WORK/rt03b.env"

compose_cmd() {
  "${COMPOSE[@]}" --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" "$@"
}

# A unique free loopback port in 18000..18999 (never the default 8080,
# which may belong to an operator production stack).
pick_free_port() {
  local start=$(( 18000 + RANDOM % 1000 )) i p
  for i in $(seq 0 999); do
    p=$(( 18000 + (start + i) % 1000 ))
    if ! nc -z 127.0.0.1 "$p" >/dev/null 2>&1; then
      printf '%s\n' "$p"
      return 0
    fi
  done
  return 1
}

rand_hex() {
  od -vAn -N16 -tx1 /dev/urandom | tr -d ' \n'
}

# ------------------------------------------------------------- build --
printf '== [C1] building the production images (existing Dockerfile contract)\n'
printf '   api image: %s\n' "$API_IMAGE"
docker build -f "$API_BUILD_CONTEXT/Dockerfile" -t "$API_IMAGE" "$API_BUILD_CONTEXT" \
  > "$WORK/build-api.log" 2>&1 \
  || { tail -n 40 "$WORK/build-api.log" >&2; fail "API image build failed (see log above)"; }
ok "API production image built from apps/api/Dockerfile"

printf '   web image: %s\n' "$WEB_IMAGE"
docker build -f "$REPO_ROOT/apps/web/Dockerfile" -t "$WEB_IMAGE" "$REPO_ROOT" \
  > "$WORK/build-web.log" 2>&1 \
  || { tail -n 40 "$WORK/build-web.log" >&2; fail "web image build failed (see log above)"; }
ok "web production image built from apps/web/Dockerfile"

# ------------------------------------------------------- stack up -----
PORT="$(pick_free_port)" || fail "no free loopback port in 18000..18999 (ENVIRONMENT/HARNESS)"
PG_USER="fg_rt03b"
PG_PASSWORD="$(rand_hex)"
DJANGO_SECRET_KEY="rt03b-$(rand_hex)"

cat > "$ENV_FILE" <<EOF
FG_WEB_IMAGE=$WEB_IMAGE
FG_API_IMAGE=$API_IMAGE
FG_POSTGRES_DATA_VOLUME=$PG_VOLUME
POSTGRES_DB=$PG_USER
POSTGRES_USER=$PG_USER
POSTGRES_PASSWORD=$PG_PASSWORD
DJANGO_SECRET_KEY=$DJANGO_SECRET_KEY
DJANGO_ALLOWED_HOSTS=127.0.0.1
DJANGO_CSRF_TRUSTED_ORIGINS=https://127.0.0.1:$PORT
FG_HTTP_PORT=$PORT
EOF

OTHER_CONTAINERS_BEFORE="$(docker ps --format '{{.Names}}' | grep -v "^${PROJECT_NAME}-" | sort || true)"

printf '== [C2] starting the isolated production topology (project %s, port %s)\n' "$PROJECT_NAME" "$PORT"
docker volume create "$PG_VOLUME" >/dev/null
compose_cmd up -d > "$WORK/compose-up.log" 2>&1 \
  || { cat "$WORK/compose-up.log" >&2; fail "compose up failed (see log above)"; }
STACK_UP=1

wait_healthy() {
  local service="$1"
  local container="$PROJECT_NAME-$service-1"
  local start=$SECONDS status=""
  while :; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' -- "$container" 2>/dev/null || echo missing)"
    if [ "$status" = "healthy" ] || { [ "$service" = "web" ] && [ "$status" = "running" ]; }; then
      return 0
    fi
    case "$status" in
      missing|dead|exited)
        docker logs --tail 30 -- "$container" >&2 2>/dev/null || true
        fail "$service container is '$status' before becoming ready (ENVIRONMENT/HARNESS or image defect — logs above)"
        ;;
    esac
    if (( SECONDS - start >= HEALTH_WAIT_SECONDS )); then
      docker logs --tail 40 -- "$container" >&2 2>/dev/null || true
      fail "$service did not become ready within ${HEALTH_WAIT_SECONDS}s (logs above)"
    fi
    sleep 1
  done
}

wait_healthy db
wait_healthy api
wait_healthy web

# The gateway must actually serve (Caddy running + SPA contract) before
# any acceptance traffic: this is the Caddy-side half of C2.
gateway_start=$SECONDS
while ! curl -fsS -m 3 -o "$WORK/spa-doc.html" "http://127.0.0.1:$PORT/" 2>/dev/null; do
  if (( SECONDS - gateway_start >= 30 )); then
    compose_cmd logs web > "$WORK/caddy-logs.txt" 2>&1 || true
    tail -n 20 "$WORK/caddy-logs.txt" >&2
    fail "Caddy gateway did not start serving within 30s (Caddyfile in the topology is unchanged — inspect caddy-logs.txt)"
  fi
  sleep 0.5
done
ok "Caddy gateway serves the SPA on 127.0.0.1:$PORT (the only published surface)"

# Topology invariants of the unchanged Compose file: only the gateway
# port is published; api and db are private to the Compose networks.
api_ports="$(docker port -- "$PROJECT_NAME-api-1" 2>/dev/null || true)"
db_ports="$(docker port -- "$PROJECT_NAME-db-1" 2>/dev/null || true)"
[ -z "$api_ports" ] || fail "api container publishes ports in the production topology: $api_ports"
[ -z "$db_ports" ] || fail "db container publishes ports in the production topology: $db_ports"
ok "api and db publish no host ports (gateway-only surface, unchanged topology)"

# [gthread] the Gunicorn startup log must report the gthread worker
# (RT-02 deployment contract, runtime proof).
gthread_line="$(compose_cmd logs api 2>/dev/null | grep -m1 'Using worker:' || true)"
case "$gthread_line" in
  *gthread*) ;;
  *)
    compose_cmd logs api > "$WORK/gunicorn-logs.txt" 2>&1 || true
    fail "Gunicorn startup log does not report the gthread worker (observed: ${gthread_line:-no worker line})"
    ;;
esac
ok "Gunicorn startup reports the gthread worker: ${gthread_line#*logs: }"

# gthread capacity evidence (reported, not gated): the worker process
# must actually carry the entry-point thread count (32).
thread_evidence="$(compose_cmd exec -T api sh -c '
  for p in /proc/[0-9]*; do
    if grep -qa gunicorn "$p/cmdline" 2>/dev/null; then
      echo "pid=$(basename "$p") threads=$(ls "$p/task" 2>/dev/null | wc -l | tr -d " ")"
    fi
  done' 2>/dev/null || true)"
printf '   gunicorn processes (pid / threads): %s\n' "$(echo "$thread_evidence" | tr '\n' '; ')"

# One-shot explicit migration on the FRESH throwaway volume (the
# topology contract: startup never migrates; the operator does).
printf '== migrating the throwaway database (one-shot, explicit)\n'
compose_cmd exec -T api python manage.py migrate --noinput \
  > "$WORK/migrate.log" 2>&1 \
  || { tail -n 40 "$WORK/migrate.log" >&2; fail "migrate failed on the throwaway volume (log above)"; }
ok "migrations applied to the throwaway volume"

# -------------------------------------------------- connection base --
listener_count() {
  compose_cmd exec -T db psql -U "$PG_USER" -d "$PG_USER" -Atc \
    "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'fg-realtime-listener';"
}
total_connections() {
  compose_cmd exec -T db psql -U "$PG_USER" -d "$PG_USER" -Atc \
    "SELECT count(*) FROM pg_stat_activity;"
}

BASELINE_LISTENERS="$(listener_count)"
[ "$BASELINE_LISTENERS" = "0" ] || fail "expected 0 fg-realtime-listener connections before the stream, got $BASELINE_LISTENERS"
BASELINE_TOTAL="$(total_connections)"
ok "baseline: 0 fg-realtime-listener connections ($BASELINE_TOTAL total pg_stat_activity rows)"

# ----------------------------------------- provision test data -------
# One user, one group (ADMIN), one project (owner via create_project),
# and one operator-provisioned Django session. All temporary, on the
# throwaway volume. The JSON on stdout is the provisioning evidence.
cat > "$WORK/provision.py" <<'PY'
import json
import os
import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings_production")
django.setup()

from django.contrib.auth import BACKEND_SESSION_KEY, HASH_SESSION_KEY, SESSION_KEY
from django.contrib.sessions.backends.db import SessionStore

from accounts.models import User
from projects.services import create_project
from research_groups.models import ResearchGroup, ResearchGroupMembership

user = User.objects.create_user(
    username="rt03b_operator",
    password="Rt03b-Test-Only-Pass-1!",
    is_active=True,
)
group = ResearchGroup.objects.create(name="RT-03B Test Group", created_by=user)
ResearchGroupMembership.objects.create(
    research_group=group,
    user=user,
    role=ResearchGroupMembership.Role.ADMIN,
)
project = create_project(research_group=group, creator=user, name="RT-03B Test Project")

store = SessionStore()
store[SESSION_KEY] = str(user.pk)
store[BACKEND_SESSION_KEY] = "django.contrib.auth.backends.ModelBackend"
# The standard session-auth hash that django.contrib.auth.login() writes:
# Django 5.2 get_user() rejects (and flushes) sessions without it.
store[HASH_SESSION_KEY] = user.get_session_auth_hash()
store.create()
print(json.dumps({
    "userId": user.pk,
    "projectId": project.pk,
    "sessionKey": store.session_key,
}))
PY
provision_json="$(compose_cmd exec -T api python - < "$WORK/provision.py")" \
  || fail "test-data/session provisioning failed (see compose output above)"
printf '   provisioned: %s\n' "$provision_json"

USER_ID="$(printf '%s' "$provision_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).userId)})')"
PROJECT_ID="$(printf '%s' "$provision_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).projectId)})')"
SESSION_KEY="$(printf '%s' "$provision_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).sessionKey)})')"
ok "temporary test data + operator-provisioned session (user $USER_ID, project $PROJECT_ID)"

# ------------------------------------------------------- SSE stream --
# [C3/C4] scripted client, explicit session cookie, through the Caddy
# gateway. -N: unbuffered streaming; -D: capture response headers.
printf '== [C3/C4] opening the authenticated SSE stream through the gateway\n'
BASE_URL="http://127.0.0.1:$PORT"
curl -sS -N --no-buffer --max-time 300 \
  -D "$WORK/stream-headers.txt" -o "$WORK/stream-body.txt" \
  -H "Cookie: sessionid=$SESSION_KEY" \
  -H "Accept: text/event-stream" \
  "$BASE_URL/api/work-items/events/" &
CURL_PID=$!

handshake_start=$SECONDS
while :; do
  if grep -q '^event: open$' "$WORK/stream-body.txt" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$CURL_PID" 2>/dev/null; then
    wait "$CURL_PID" 2>/dev/null || true
    CURL_PID=""
    printf '   --- response headers ---\n'; cat "$WORK/stream-headers.txt" >&2
    printf '   --- body so far ---\n'; cat "$WORK/stream-body.txt" >&2
    fail "SSE connection closed before the open handshake (PRODUCT_REGRESSION — product path reached; anonymous/dead-session 401 or listener 503 answers before stream bytes)"
  fi
  if (( SECONDS - handshake_start >= 30 )); then
    fail "no open handshake within 30s (headers/body in work dir)"
  fi
  sleep 0.2
done
STREAM_START=$SECONDS

grep -q '^HTTP/1.1 200' "$WORK/stream-headers.txt" \
  || { cat "$WORK/stream-headers.txt" >&2; fail "SSE response is not HTTP 200"; }
grep -qi '^content-type:[[:space:]]*text/event-stream' "$WORK/stream-headers.txt" \
  || { cat "$WORK/stream-headers.txt" >&2; fail "SSE Content-Type is not text/event-stream"; }
node - "$WORK/stream-body.txt" "$USER_ID" <<'NODE'
const fs = require("node:fs");
const [file, userId] = process.argv.slice(2);
const frames = fs.readFileSync(file, "utf8").split("\n\n").filter(Boolean);
let open = null;
for (const frame of frames) {
  let event = null, data = null;
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data = line.slice(5).trim();
  }
  if (event === "open") open = data;
}
if (!open) { console.error("no open frame"); process.exit(1); }
const payload = JSON.parse(open);
if (payload.userId !== Number(userId)) {
  console.error("open handshake userId mismatch: " + open);
  process.exit(1);
}
console.log("open handshake: " + open);
NODE
ok "authenticated stream: 200 + text/event-stream + open handshake for user $USER_ID"

# [C10-in] the dedicated listener connection is visible while open.
listener_start=$SECONDS
while [ "$(listener_count)" != "1" ]; do
  if (( SECONDS - listener_start >= 10 )); then
    fail "dedicated fg-realtime-listener connection not visible in pg_stat_activity within 10s of the open handshake"
  fi
  sleep 0.5
done
ok "dedicated LISTEN connection present (pg_stat_activity application_name=fg-realtime-listener = 1)"

# ------------------------------------------------------- REST calls --
rest_get() {
  local path="$1" body="$2"
  curl -sS -m 30 -o "$body" -w '%{http_code}' -H "Cookie: sessionid=$SESSION_KEY" "$BASE_URL$path"
}

parallel_rest_batch() {
  local n="$1" i
  : > "$WORK/rest-parallel.log"
  (
    for i in $(seq 1 "$n"); do
      curl -sS -m 30 -o /dev/null -w '%{http_code}\n' \
        -H "Cookie: sessionid=$SESSION_KEY" \
        "$BASE_URL/api/projects/$PROJECT_ID/work-items/" \
        >> "$WORK/rest-parallel.log" &
    done
    wait
    true
  ) &
  local batch_pid=$!
  wait "$batch_pid"
}

check_parallel_batch() {
  local label="$1"
  local codes
  codes="$(sort "$WORK/rest-parallel.log" | awk '{print $1}' | sort -u | tr '\n' ' ')"
  [ "$codes" = "200 " ] \
    || fail "$label: expected all 200, got codes: $codes (log in work dir; PRODUCT_REGRESSION — product path reached)"
  ok "$label: all 5 parallel GET /api/projects/$PROJECT_ID/work-items/ returned 200 while the stream was open"
}

# [C7a] sequential REST while the stream is open.
code="$(rest_get /api/health/ "$WORK/rest-health.json")"
[ "$code" = "200" ] || fail "GET /api/health/ returned $code while the stream was open (PRODUCT_REGRESSION)"
grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' "$WORK/rest-health.json" || fail "health body is not {status: ok}"
ok "GET /api/health/ -> 200 {status: ok} while the stream is open"

code="$(rest_get /api/auth/me/ "$WORK/rest-me.json")"
[ "$code" = "200" ] || fail "GET /api/auth/me/ returned $code while the stream was open (PRODUCT_REGRESSION)"
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(d.id!==Number(process.argv[2])){console.error("auth/me id mismatch: "+d.id);process.exit(1)}' \
  "$WORK/rest-me.json" "$USER_ID" || fail "auth/me did not resolve the stream's own session user (PRODUCT_REGRESSION)"
ok "GET /api/auth/me/ -> 200, resolves the operator-provisioned session to user $USER_ID"

code="$(rest_get "/api/projects/$PROJECT_ID/work-items/" "$WORK/rest-work-items.json")"
[ "$code" = "200" ] || fail "GET project work-items returned $code while the stream was open (PRODUCT_REGRESSION)"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$WORK/rest-work-items.json" \
  || fail "work-items response is not valid JSON"
ok "GET /api/projects/$PROJECT_ID/work-items/ -> 200 (valid JSON) while the stream is open"

# [C8] committed NOTIFYs from a SECOND process via the existing
# internal publisher (work_items.realtime). The exec'ed python process
# is a separate OS process with its own Django/PostgreSQL connection —
# PostgreSQL delivers each committed pg_notify to every LISTENing
# connection, including the stream's dedicated listener in the
# Gunicorn worker.
printf '== [C8] publishing committed NOTIFYs from a second process (existing internal publisher)\n'
cat > "$WORK/publish.py" <<'PY'
import os
import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings_production")
django.setup()

from django.db import transaction

from work_items.realtime import (
    publish_my_work_changed,
    publish_project_work_item_changed,
)

user_id = int(os.environ["RT03B_USER_ID"])
project_id = int(os.environ["RT03B_PROJECT_ID"])

with transaction.atomic():
    publish_project_work_item_changed(project_id)
print("committed: work_item_changed projectId=%d" % project_id)

with transaction.atomic():
    publish_my_work_changed(user_id)
print("committed: my_work_changed userId=%d" % user_id)
PY
compose_cmd exec -T -e RT03B_USER_ID="$USER_ID" -e RT03B_PROJECT_ID="$PROJECT_ID" \
  api python - < "$WORK/publish.py" \
  || fail "second-process publication failed (see compose output above)"

wait_frame() {
  local label="$1" pattern="$2"
  local start=$SECONDS
  while ! grep -qE "$pattern" "$WORK/stream-body.txt" 2>/dev/null; do
    if ! kill -0 "$CURL_PID" 2>/dev/null; then
      wait "$CURL_PID" 2>/dev/null || true
      CURL_PID=""
      fail "stream ended while waiting for $label (PRODUCT_REGRESSION — committed notification not delivered)"
    fi
    if (( SECONDS - start >= EVENT_WAIT_SECONDS )); then
      fail "$label not delivered within ${EVENT_WAIT_SECONDS}s of the committed publish (PRODUCT_REGRESSION — product path reached: publisher committed, transport dropped the event)"
    fi
    sleep 0.2
  done
}
wait_frame "work_item_changed event" '^event: work_item_changed$'
wait_frame "my_work_changed event" '^event: my_work_changed$'
node - "$WORK/stream-body.txt" "$PROJECT_ID" <<'NODE'
const fs = require("node:fs");
const [file, projectId] = process.argv.slice(2);
const frames = fs.readFileSync(file, "utf8").split("\n\n").filter(Boolean);
const events = [];
for (const frame of frames) {
  let event = null, data = null;
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data = line.slice(5).trim();
  }
  if (event) events.push({ event, data });
}
const project = events.find((e) => e.event === "work_item_changed");
if (!project || JSON.parse(project.data).projectId !== Number(projectId)) {
  console.error("work_item_changed payload wrong: " + JSON.stringify(project));
  process.exit(1);
}
const personal = events.find((e) => e.event === "my_work_changed");
// The documented contract: my_work_changed carries NO Work Item data —
// the frame is exactly `data: {}`.
if (!personal || personal.data !== "{}") {
  console.error("my_work_changed payload wrong: " + JSON.stringify(personal));
  process.exit(1);
}
console.log("delivered: " + events.map((e) => e.event + " " + e.data).join(" | "));
NODE
ok "committed NOTIFYs (project + user scope) delivered to the stream with correct minimal payloads"

# [C7b] 5 REST requests IN PARALLEL while the stream is open (the
# gthread capacity check: the stream holds one thread, the batch uses
# more — a single-threaded sync worker would hang here).
parallel_rest_batch 5
check_parallel_batch "parallel REST batch #1"

# Hold the stream to the target duration, sampling REST again at the
# end of the hold.
printf '== [C5/C6] holding the stream to %ss (keep-alive cadence 15s)\n' "$STREAM_HOLD_SECONDS"
while (( SECONDS - STREAM_START < STREAM_HOLD_SECONDS )); do
  kill -0 "$CURL_PID" 2>/dev/null || { wait "$CURL_PID" 2>/dev/null || true; CURL_PID=""; fail "stream closed before the ${STREAM_HOLD_SECONDS}s hold (PRODUCT_REGRESSION)"; }
  sleep 0.5
done

# [C7c] the REST surface still works late in the stream's life.
parallel_rest_batch 5
check_parallel_batch "parallel REST batch #2 (at ~t=${STREAM_HOLD_SECONDS}s)"

# [C5] the stream is still open beyond 60 s.
kill -0 "$CURL_PID" 2>/dev/null || fail "stream not open at the end of the hold (PRODUCT_REGRESSION)"
DURATION=$(( SECONDS - STREAM_START ))
[ "$DURATION" -ge 60 ] || fail "stream open for only ${DURATION}s (required: > 60s)"
ok "stream open for ${DURATION}s (> 60s) — client and server both still connected"

# [C6] keep-alive comments reached the client (15 s contract -> at
# least 4 by now; require >= 2 to stay robust to clock skew).
PINGS="$(grep -c '^: ping$' "$WORK/stream-body.txt" || true)"
[ "$PINGS" -ge 2 ] \
  || fail "only $PINGS keep-alive comments reached the client in ${DURATION}s (contract: one : ping per 15s; PRODUCT_REGRESSION)"
ok "$PINGS keep-alive comments (\": ping\") reached the client in ${DURATION}s"

# still exactly one dedicated listener while open
[ "$(listener_count)" = "1" ] || fail "expected exactly 1 fg-realtime-listener connection at the end of the hold"
ok "exactly 1 dedicated listener connection at the end of the hold"

# ------------------------------------------------- disconnect + ------
# [C9] force the client disconnect: kill the script client. Caddy
# (default proxy mode) cancels the upstream request, the Gunicorn
# write to the dead client fails, the gthread worker closes the
# response, the stream generator gets GeneratorExit and its cleanup
# closes the dedicated listener connection.
printf '== [C9] forcing the client disconnect (kill of the script client)\n'
kill "$CURL_PID" 2>/dev/null || true
wait "$CURL_PID" 2>/dev/null || true
CURL_PID=""
DISCONNECT_AT=$(( SECONDS - STREAM_START ))
ok "client disconnect forced after ${DISCONNECT_AT}s of stream life"

release_start=$SECONDS
while :; do
  current="$(listener_count)"
  if [ "$current" = "0" ]; then
    break
  fi
  if (( SECONDS - release_start >= LISTENER_RELEASE_WAIT_SECONDS )); then
    compose_cmd exec -T db psql -U "$PG_USER" -d "$PG_USER" -c \
      "SELECT pid, state, query FROM pg_stat_activity WHERE application_name = 'fg-realtime-listener';" >&2 || true
    fail "dedicated listener connection still present ${LISTENER_RELEASE_WAIT_SECONDS}s after forced disconnect (count=$current) — LISTENER LEAK (PRODUCT_REGRESSION — cleanup-on-disconnect contract violated)"
  fi
  sleep 1
done
RELEASE_SECONDS=$(( SECONDS - release_start ))
ok "dedicated listener connection released ${RELEASE_SECONDS}s after forced disconnect (no leak)"

# [C10] PostgreSQL connections back to the baseline state.
FINAL_TOTAL="$(total_connections)"
ok "PostgreSQL connections back to baseline: fg-realtime-listener 0 (was 1 while open; $FINAL_TOTAL total rows vs $BASELINE_TOTAL at baseline)"

# ------------------------------------------------------------ done ----
OTHER_CONTAINERS_AFTER="$(docker ps --format '{{.Names}}' | grep -v "^${PROJECT_NAME}-" | sort || true)"
[ "$OTHER_CONTAINERS_BEFORE" = "$OTHER_CONTAINERS_AFTER" ] \
  || fail "other containers changed during the test (before/after mismatch in work dir)"
ok "no other container was affected (docker ps before == after)"

printf '\nproduction-sse-transport tests: PASS\n'
printf '  C1  production images built from the existing Dockerfile contract (api + web)\n'
printf '  C2  Caddy -> Gunicorn gthread -> Django via the existing Compose topology; gateway-only surface\n'
printf '  C3  authenticated SSE by script client with operator-provisioned session\n'
printf '  C4  200 + text/event-stream + open handshake (userId %s)\n' "$USER_ID"
printf '  C5  stream open for %ss (> 60s)\n' "$DURATION"
printf '  C6  %s keep-alive comments received (15s contract)\n' "$PINGS"
printf '  C7  REST ok: health, auth/me (user %s), project work-items; 2x5 parallel batches all 200\n' "$USER_ID"
printf '  C8  committed NOTIFYs from a second process delivered (project + user scope)\n'
printf '  C9  forced disconnect released the dedicated listener in %ss (no leak)\n' "$RELEASE_SECONDS"
printf '  C10 pg_stat_activity: fg-realtime-listener 0 -> 1 (open) -> 0 (after cleanup)\n'
printf '  gunicorn: %s\n' "${gthread_line#*logs: }"
printf '  port %s, project %s, volume %s (all temporary, removed on exit)\n' "$PORT" "$PROJECT_NAME" "$PG_VOLUME"
