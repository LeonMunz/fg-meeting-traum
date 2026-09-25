# FG Workspace — Testing & Living Lab

## Purpose

The Living Lab validates whether the product model and UX work for real research-group coordination.

The goal is product learning, not feature count.

Until institutional privacy/hosting requirements are resolved, use synthetic test data.

## Testing strategy

Tests are part of development, not a later hardening activity.

Prioritize business rules and authorization over broad visual snapshot testing.

## Domain tests

### Project

- Project creator becomes Owner.
- A non-Research-Group member cannot become ProjectMember.
- An active Project never loses its last Owner.

### Work Item

- Project is mandatory.
- Assignee must be Project Owner or Member.
- Viewer cannot be assigned.
- Parent belongs to the same Project.
- Parent hierarchy cannot cycle.
- `blockedReason` present → blocked; empty → not blocked.
- `completed_at` set when status_definition.category becomes `done`.
- `completed_at` cleared when status_definition.category leaves `done`.

### WorkItem Configuration

- Every new Project receives default TypeDefinitions: Epic, Milestone,
  Deliverable, Task.
- Every new Project receives default StatusDefinitions: Todo (default,
  category todo), In Progress (in_progress), Review (review), Done (done).
- A Project owner may create, rename, reorder, and deactivate Types,
  Statuses, and Labels.
- A Project member may read configuration but not mutate it.
- A Project viewer may read configuration but not mutate WorkItems.
- A StatusDefinition's category is immutable once referenced by a WorkItem.
- Each Project has exactly one active default StatusDefinition (category
  `todo`). Deactivating it is forbidden without a replacement.
- Deactivating a used Type, Status, or Label does not affect existing
  WorkItems. The definition remains readable.
- WorkItem labels are a relational many-to-many join.
- Cross-Project configuration assignment is forbidden.
- Project A configuration is independent from Project B configuration.

### Meeting

After Meeting implementation:
- Project Meeting contains only users with Project access.
- Research Group Meeting does not expose private Project objects.
- Meeting lifecycle transitions (start/end/reopen) are guarded server-side.

## Permission tests

For protected Project resources, test at least:

- Owner
- Member
- Viewer
- no ProjectMembership
- user from another Research Group

Cover relevant actions such as:
- list
- get
- create
- update
- membership changes

The critical property is not only returning `403` for detail access; list endpoints must also avoid leaking inaccessible objects.

## Integration tests

Core cross-feature flow:

```text
Project
→ Work Item
→ My Work
```

Later:

```text
Meeting
→ Work Item
→ My Work
→ Project Board
```

## E2E priority

The first E2E target is the Core checkpoint:

```text
Alex logs in
→ creates Paper XYZ
→ becomes Owner
→ adds Chris
→ assigns Chris a Work Item

Chris logs in
→ sees Paper XYZ
→ sees the Work Item in My Work
→ sees the same Work Item in Project Board

Maria logs in
→ cannot see Paper XYZ
```

Automate this browser flow once the underlying product slice is stable enough that the E2E test provides value.

## Seed data

Maintain reproducible backend seed data for development and Living-Lab testing.

Suggested synthetic baseline:

Research Group:
```text
FG Example
```

Users:
```text
Alex
Chris
Maria
Laura
```

Projects:
```text
Paper XYZ
- Alex: owner
- Chris: member

Teaching Tool
- Maria: owner
- Laura: member
```

Add Work Items in several states when Work Items exist.

After Meetings exist, add:
- one Weekly
- several Topics
- representative MeetingItems

Seed data is not a second business logic implementation. It must obey the same domain rules as normal data.

## Reset

The Living-Lab test environment needs a documented reset to the baseline seed state.

This allows repeated sessions to start from comparable data.

Reset must be restricted to development/test environments.

## Environments

At minimum:

```text
Development
Living Lab / Test
```

The Living-Lab environment uses:
- PostgreSQL persistence
- migrations
- authenticated users
- server-side authorization

A test session should be attributable to an identifiable product version/commit.

### Production configuration boundary

`config.settings_production` is the fail-closed Django boundary for the
intended same-origin HTTPS deployment. The production process must explicitly
provide `DJANGO_SECRET_KEY`, all five current PostgreSQL connection values
(`POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_HOST`, and
`POSTGRES_PORT`), comma-separated `DJANGO_ALLOWED_HOSTS`, and comma-separated
`DJANGO_CSRF_TRUSTED_ORIGINS`. Trusted CSRF origins must be explicit HTTPS
origins; development localhost origins are confined to the development
settings module.

TLS is expected to terminate at a trusted reverse proxy. Django trusts exactly
`X-Forwarded-Proto: https` through `SECURE_PROXY_SSL_HEADER` and redirects
requests it does not recognize as secure. The Django application port must
therefore remain private and accept traffic only from the trusted proxy;
otherwise an untrusted client could forge that header. Secure session and CSRF
cookies remain mandatory.

HSTS is deliberately deferred until the real hostname, TLS termination, and
proxy path have passed deployment acceptance. Until then, Django's
`check --deploy` is expected to retain `security.W004`; do not describe that
check as clean and do not enable long-lived HSTS merely to silence it.

The backend production image is defined by `apps/api/Dockerfile`, built with
`apps/api/` as its context. It installs the committed `uv.lock` with frozen,
runtime-only dependency resolution and runs Gunicorn as a non-root user on the
private container port `8000`. Its default settings module is
`config.settings_production`; secrets, database connection values, allowed
hosts, and trusted CSRF origins remain runtime-owned configuration and are
never image inputs.

Starting the application container only starts Gunicorn. It never runs
migrations, seeds, resets, or other database-mutating management commands.
Migration files and `manage.py` remain in the image so release orchestration
can invoke an explicit one-shot command in a later slice. `GET /api/health/`
is process liveness only and deliberately performs no database readiness
check.

This backend runtime artifact alone does not make FG Workspace deployable.
The local production Compose topology (one loopback gateway, `/api`
reverse proxy, durable PostgreSQL storage on a separately managed external
volume) is now implemented as local-only infrastructure — see Local
production stack below. TLS/public hostname, backup/restore,
migration/release orchestration, and deployment automation remain
separate follow-up work; immutable image publication to GHCR is
implemented — see Production image publication (GHCR) below.

### Local production stack (Compose topology)

`deploy/compose.production.yaml` runs FG Workspace as one production-shaped
local stack behind a single loopback gateway. It is deliberately NOT the
public deployment: no public hostname, no TLS/ACME, no image publishing.
Backup and release operations are manual, operator-invoked primitives
with no automation (see "PostgreSQL logical backup and restore" and
"Manual exact-SHA release" below).

```text
127.0.0.1:<FG_HTTP_PORT, default 8080>
                 |
                 v
               web    Caddy: static SPA + /api reverse proxy
                 |
                 v   [gateway network: web <-> api]
               api    Gunicorn (config.settings_production), private :8000
                 |
                 v   [data network: api <-> db, internal]
               db     PostgreSQL 16 (digest-pinned 16.15-bookworm),
                      external persistent volume
```

Dominant invariants:

- Application containers are disposable: `web` and `api` consume prebuilt
  images (`FG_WEB_IMAGE`, `FG_API_IMAGE`); the Compose file carries no
  `build:` for application services.
- PostgreSQL data lives in a separately managed external Docker volume
  (`FG_POSTGRES_DATA_VOLUME` at `/var/lib/postgresql/data`). Compose never
  creates or deletes it: `down` + container/stack recreation preserves all
  data, and removing the volume is an explicit, destructive operator
  decision (the operator backup tooling backs up this topology's
  DATABASE as a logical archive; the volume itself is never copied or
  moved by it — see the section below).
- Only the Caddy gateway is reachable from the host, and only on loopback.
  `api` (8000) and `db` (5432) have no host ports, and `web` cannot
  address `db` (no shared network).
- `web`, `api`, and `db` use `restart: unless-stopped`, so the existing
  stack returns after Docker or the host restarts unless an operator
  explicitly stopped a container. This policy does not replace the
  service healthchecks or deployment verification.

Local acceptance procedure (Docker-capable machine; the development setup
uses `colima start` for the Docker daemon):

```bash
# 1) Build local test images from the current worktree (image contracts
#    from the backend/frontend production container slices).
docker build -f apps/web/Dockerfile -t fg-workspace-web:compose-topology-local .
docker build -f apps/api/Dockerfile -t fg-workspace-api:compose-topology-local apps/api

# 2) Create the external PostgreSQL data volume ONCE (operator-owned).
docker volume create fg_production_pg16_data

# 3) Runtime configuration (the repository holds placeholders only).
cp deploy/.env.example deploy/.env   # then fill in real local values:
#    FG_WEB_IMAGE, FG_API_IMAGE, FG_POSTGRES_DATA_VOLUME,
#    POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD,
#    DJANGO_SECRET_KEY, DJANGO_ALLOWED_HOSTS=127.0.0.1,
#    DJANGO_CSRF_TRUSTED_ORIGINS=https://127.0.0.1:8080

# 4) Start (Compose auto-loads deploy/.env from the project directory).
docker-compose -f deploy/compose.production.yaml up -d
docker-compose -f deploy/compose.production.yaml ps   # expect: db, api, web all healthy

# 5) Gateway acceptance.
curl -fsS http://127.0.0.1:8080/ | head -c 200                  # SPA document
curl -fsSI http://127.0.0.1:8080/ | grep -i '^cache-control'    # no-cache
# Fingerprinted asset referenced by the served document:
curl -fsSI "http://127.0.0.1:8080/assets/<fingerprinted-asset>.js" | grep -i '^cache-control'  # immutable
curl -fsS http://127.0.0.1:8080/api/health/                     # {"status": "ok"} via proxy
curl -fsS http://127.0.0.1:8080/meetings | head -c 100          # SPA fallback document

# 6) Network isolation (both commands must fail to resolve).
docker-compose -f deploy/compose.production.yaml exec web getent hosts db
docker-compose -f deploy/compose.production.yaml exec db  getent hosts web

# 7) DB readiness + explicit one-shot migration (never automatic).
docker-compose -f deploy/compose.production.yaml exec api python manage.py migrate

# 8) Persistence across container/stack recreation.
docker-compose -f deploy/compose.production.yaml exec db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE TABLE IF NOT EXISTS topology_persistence_check (id int primary key);"'
docker-compose -f deploy/compose.production.yaml down
docker-compose -f deploy/compose.production.yaml up -d
docker-compose -f deploy/compose.production.yaml exec db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\dt topology_persistence_check"'
# expect: the table survives

# 9) Teardown keeps the volume.
docker-compose -f deploy/compose.production.yaml down
docker volume ls   # fg_production_pg16_data still exists
# docker volume rm fg_production_pg16_data   # ONLY an explicit data-destruction decision
```

Caveats (read before using the loopback surface):

- **Temporary local bridge**: the gateway is loopback HTTP, and the deploy
  Caddyfile injects `X-Forwarded-Proto: https` toward `api` to satisfy the
  production settings contract. Secure session/CSRF cookies and HTTPS-only
  trusted origins make browser login impossible over plain HTTP, so this
  surface is for operational acceptance, not authenticated browser use.
  The public slice terminates real TLS at this same gateway.
- `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` apply to first
  initialization only; on an already-initialized volume the existing
  cluster (and its credentials) is authoritative.
- Startup and Docker restarts run no migrations and no seeding; run
  explicit one-shot commands (step 7) — or the manual exact-SHA release
  transaction below, which performs the migration explicitly once from the
  new API image.

### PostgreSQL logical backup and restore (operator procedure)

Manual, operator-facing recovery primitives for the application database of
the local production topology. They are NOT automation: nothing schedules,
rotates, uploads, or restores by itself. Canonical scripts:
`deploy/scripts/postgres-backup.sh` and
`deploy/scripts/postgres-restore-empty.sh` (script tests:
`scripts/tests/postgres-backup-restore.test.sh`).

Dominant recovery invariant: a backup is not usable merely because
`pg_dump` exited successfully. It must be an atomic custom-format archive
(`pg_dump -Fc`), validated by `pg_restore --list`, carry a SHA-256 checksum
sidecar, and — to count as proven recoverable — have been restored into a
completely fresh PostgreSQL data volume. Restore never overwrites a
non-empty database.

Create a backup (the database stays online: no service is stopped, paused,
or locked; no host port is opened; all PostgreSQL tooling runs inside the
pinned `db` container, so the host needs no PostgreSQL client):

```bash
deploy/scripts/postgres-backup.sh \
  --env-file deploy/.env \
  --output-dir /path/outside/repo/backups
```

(If the stack runs under a non-default Compose project name, both scripts
accept `--project-name <name>`; the default is the project declared in
`deploy/compose.production.yaml`, `fg-production`.)

Artifact contract:

- Naming: `fg-workspace-<database>-YYYYMMDDTHHMMSSZ.dump` (UTC timestamp)
  plus a `sha256sum`-compatible sidecar `…dump.sha256`
  (`<hash>  <archive-basename>`).
- Written as `…dump.partial` first; published by atomic rename only after
  the non-empty check and a successful `pg_restore --list` parse (the
  archive is staged into the `db` container's ephemeral filesystem for
  validation, never into the data volume).
- Files are created with restrictive permissions (umask 077 → 0600).
- The output directory must exist, be writable, and must NOT be inside the
  repository.
- On any failure: no final-looking archive remains, the partial is
  removed, and the exit code is non-zero.

Restore ONLY into an empty target database:

```bash
deploy/scripts/postgres-restore-empty.sh \
  --env-file deploy/.env \
  --archive /path/outside/repo/backups/fg-workspace-<database>-….dump
```

Preconditions are enforced in order, ALL before any database write:

1. the archive exists and is non-empty;
2. the SHA-256 sidecar (default `<archive>.sha256`, overridable with
   `--checksum`) exists, is a single well-formed line naming exactly this
   archive, and matches — a missing or invalid checksum fails closed
   BEFORE any Docker/PostgreSQL interaction;
3. the archive parses (`pg_restore --list` through the `db` container);
4. the target database contains no user-schema relations (tables, views,
   materialized views, sequences, foreign/partitioned tables) and no user
   functions — system catalogs never count; a migrated or populated
   database is refused with a clear message, zero changes, and a non-zero
   exit.

The restore then runs `pg_restore --exit-on-error` into the EXISTING
configured application database. The image bootstrap owns database
creation: the script never creates, drops, cleans, or deletes anything.
There is deliberately NO `--force`, NO destructive bypass of the
emptiness guard, NO `--clean`, NO `--create`, and NO automatic volume
deletion. No `--no-owner` / `--no-acl` either: the runtime contract
recreates the same application role from `POSTGRES_USER` on a fresh
volume, so archived ownership and ACLs restore cleanly and the archive
stays authoritative. If `pg_restore` fails part-way, the target may hold
partial objects: re-prepare a fresh empty target (e.g. a fresh external
volume) before any retry.

Restore verification (direct database evidence — the liveness-only
`GET /api/health/` is NOT recovery evidence):

```bash
# expected application objects restored (expect a non-zero count):
docker-compose -f deploy/compose.production.yaml exec db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = '\''public'\''"'
# migration history intact + no unapplied migrations (explicit one-shot):
docker-compose -f deploy/compose.production.yaml run --rm api python manage.py migrate --check
```

Sensitivity: backups contain the complete team dataset (identities,
projects, meetings, notes). Treat `.dump` and `.sha256` files like
production data: restrictive permissions by default, never commit them to
the repository, store them only where authorized.

Current limitations (deliberately NOT implemented in this slice):

- No scheduling, retention/rotation, off-host upload, or encryption
  (later slices).
- Logical recovery point only: NO Point-in-Time Recovery (no WAL
  archiving; `wal_level` / `archive_mode` / `archive_command` are never
  modified).
- Not a full cluster backup: no `pg_dumpall`. Runtime configuration is the
  source of truth for the application DB role (recreated from
  `POSTGRES_USER` / `POSTGRES_PASSWORD` on a fresh volume); no custom
  tablespaces exist in this architecture.
- No destructive in-place production restore and no automatic volume
  deletion: disaster cutover is a later, explicitly designed runbook.

### Production image publication (GHCR)

`.github/workflows/publish-images.yml` (`Production image publication
(GHCR)`) publishes, for every verified `main` commit, exactly two
immutable production images to GitHub Container Registry:

```text
ghcr.io/<owner>/<repo>-api :<40-char Git SHA>
ghcr.io/<owner>/<repo>-web :<40-char Git SHA>
```

(`<owner>` / `<repo>` = the lowercase GitHub repository identity — e.g.
`ghcr.io/example/fg-meeting-traum-api:dc836752198bd68ce9f58f1604680ccc8f049877`
is the shape, not a real reference.)

Contract:

- **Trigger + gate** — publication runs only when a COMPLETED and
  SUCCESSFUL run of the canonical Core verification workflow (its
  exact top-level `name:` value, `Core verification`) for a `push` to
  `main` finishes — a `workflow_run` dependency by workflow name
  (renaming that `name:` requires updating the publication workflow's
  `workflows:` list). The
  publication workflow re-runs no test suite and verifies nothing by
  itself; a failed, cancelled, pull-request, dispatch, or non-main core
  run publishes nothing (both jobs skip).
- **Immutability** — the exact 40-character Git commit SHA is the ONLY
  tag. No `latest`, branch, short-SHA, or timestamp tag is ever
  published. The built revision is the core run's head SHA (for a push
  to main: the pushed commit); each job checks out exactly that
  revision and asserts `git rev-parse HEAD` equals it before any build.
- **Builds** — the existing production Dockerfiles unchanged:
  `apps/api/Dockerfile` (context `apps/api/`) and `apps/web/Dockerfile`
  (context = repository root), via Docker Buildx (official, SHA-pinned
  Docker actions) on pinned `ubuntu-24.04` runners. Platform contract:
  `linux/amd64` (the documented VServer target); every base-image
  digest in both Dockerfiles was verified against the registries to be
  a multi-platform index carrying linux/amd64.
- **Authentication** — the runner's `GITHUB_TOKEN` only, under the
  minimum workflow permissions `contents: read` + `packages: write`.
  No PAT, no repository secret, no long-lived credential, no BuildKit
  cache (cold-cache builds are the verified contract).
- **Metadata** — standard OCI labels on both images
  (`org.opencontainers.image.source` / `.revision` / `.repos`) plus
  BuildKit provenance attestation.
- **Both or nothing** — the two jobs run in parallel and BOTH must
  succeed; a revision is deployment-ready only when BOTH image
  artifacts exist.

Publishing is NOT deployment: the workflow touches no server, no
VServer, and no Compose stack. The published references are exactly the
values for the existing required Compose variables of the local
production topology (and later the VServer topology):

```bash
FG_API_IMAGE=ghcr.io/<owner>/<repo>-api:<full commit SHA>
FG_WEB_IMAGE=ghcr.io/<owner>/<repo>-web:<full commit SHA>
docker-compose -f deploy/compose.production.yaml config   # unchanged topology
```

Registry visibility boundary: whether the created GHCR packages are
publicly pullable is a repository/package setting outside this slice
and is NOT derivable from repository code. If the packages are private,
the later VServer bootstrap must configure a minimal pull credential
(e.g. a fine-grained token with read access to this repository's
packages only); no such credential exists in this repository, and this
slice adds none.

External acceptance (first real `main` run after integration): the
publication run is green, both images were pushed, both carry the exact
main commit SHA as their tag, and — where registry visibility permits —
both full-SHA references pull cleanly (`docker pull` of each reference
from a clean Docker client, or registry metadata).

Static contract test: `scripts/tests/publish-workflow.test.sh`.

### Manual exact-SHA release (operator procedure)

`deploy/scripts/release.sh` is ONE fail-closed operator command that
releases the local production topology to a specific published commit.
It orchestrates the existing primitives only — the production Compose
file, the PostgreSQL backup script, and the `/api/health/` endpoint —
and adds no automation, no rollback, and no restore of any kind.

Prerequisites:

- the target commit's image pair was published by the production image
  publication workflow: `<image-base>-api:<FULL_SHA>` and
  `<image-base>-web:<FULL_SHA>` (a revision is deployment-ready only
  when BOTH image artifacts exist);
- the production stack has running, healthy db and api containers and a
  running web container — the backup requires the running `db` service;
- an existing backup directory OUTSIDE the repository;
- the Docker CLI, the Compose CLI with a reachable Docker daemon
  (`docker compose` preferred, `docker-compose` fallback), and `curl`
  on the host.

Invocation:

```bash
deploy/scripts/release.sh <FULL_SHA> \
  --env-file deploy/.env \
  --image-base ghcr.io/<owner>/<repo> \
  --backup-dir /path/outside/repo/backups \
  [--project-name <name>]
```

- `<FULL_SHA>` must be exactly 40 lowercase hex characters; short
  SHAs, branch names, mutable tags (e.g. `latest`), uppercase, and
  malformed input are rejected before anything runs.
- The release derives `FG_API_IMAGE=<image-base>-api:<sha>` and
  `FG_WEB_IMAGE=<image-base>-web:<sha>` — the same SHA for both
  services — and uses those references for every Compose operation
  (configuration validation, pull, migration, stack update).
- `--env-file` defaults to `deploy/.env`; `--project-name` defaults to
  the Compose-declared project (`fg-production`).

Phase order (every phase failure exits non-zero and prevents all later
phases; there is NO automatic restore and NO automatic rollback):

1. `VALIDATION` — release identity + inputs (before any runtime
   mutation).
2. `COMPOSE_CONFIG` — production Compose interpolation/configuration
   validated with the derived full-SHA image references; no image
   fetch, no containers.
3. `BACKUP` — `deploy/scripts/postgres-backup.sh` with the same env
   file, backup directory, and project name; the backup script remains
   authoritative for dump validation, checksum, and atomic publication.
   The database stays online.
4. `IMAGE_PULL` — pulls only the exact `<base>-api:<sha>` and
   `<base>-web:<sha>` images; no source build; the running stack is
   not mutated.
5. `MIGRATION` — exactly ONE `manage.py migrate --noinput` executed
   from the NEW api image in a one-shot container (`compose run --rm
   --no-deps api ...` — never `exec` on the running old container),
   followed by `manage.py migrate --check` from the same new-image
   contract. Normal API startup remains Gunicorn-only.
6. `STACK_UPDATE` — updates only the `api` and `web` services; the db
   service and the PostgreSQL volume are never recreated or deleted.
7. `HEALTH` — (a) resolve each api/web/db container ID with Compose,
   then inspect it with the Docker CLI: every container must exist and
   be running, and every configured healthcheck must become `healthy`
   within the bounded release health retry window (`starting` waits;
   `unhealthy` fails immediately);
   (b) same-origin API liveness `GET /api/health/` through the web
   gateway on the Compose-reported published port (`compose port web
   8080` — no port parsing from `.env`, no hardcoded gateway port;
   bracketed/bare IPv6 is normalized without double brackets and
   wildcard IPv4/IPv6 bindings use the matching loopback address for
   the local probe); (c) gateway smoke `GET /`; (d) schema readiness
   (the release's `migrate --check` succeeded). Liveness only — not
   database correctness.

Verification is deliberately smaller than broad E2E: no authenticated
flows, no seeded-user requirements. The success report includes the
requested SHA, both image refs, the backup archive, migration success,
and health/smoke success. Compose resolves the running api/web container
IDs and regular `docker inspect` reads
`org.opencontainers.image.revision` from their metadata (advisory;
locally built test images may lack the OCI label). No application
version endpoint is introduced.

Failure boundaries (fail closed; recovery is a manual, explicit
operator decision):

- **Backup failure** — no pull, no migration, no stack update; the
  running stack and the database are unchanged.
- **Pull failure** — the running stack and the database are unchanged.
- **Migration failure** — the release stops immediately: NO retry, NO
  restore, NO rollback to old images. A migration is NOT assumed
  retry-safe: it may be non-atomic, irreversible, or have external
  side effects. The report states that the database MAY have changed,
  that operator investigation/recovery is REQUIRED, and identifies the
  predeploy backup (the archive + `.sha256` sidecar from the BACKUP
  phase) as the recovery artifact.
- **`migrate --check` failure** — the stack is NOT updated.
- **Stack update failure** — the database has ALREADY been migrated;
  operator intervention may be necessary; no automatic rollback.
- **Health/smoke failure** — non-zero exit; the release performs no
  rollback of any kind.

The release never executes: a source build, a mutable tag (`latest`,
branch, or short-SHA reference), `compose down` (with or without
volume flags), `docker volume rm`, an automatic restore
(`postgres-restore-empty.sh` is a separate, explicit operator decision),
or a restart of old images as a claimed rollback.

Deterministic contract test (no Docker daemon, registry, network, or
production secrets): `scripts/tests/release-transaction.test.sh`.

The transaction is implemented, but real release execution against
Docker/GHCR/VServer is not yet accepted. VServer bootstrap, real
TLS/domain, automatic deployment, automatic rollback, scheduled/off-host
backups, and PITR remain future work.

## Environment doctor (read-only)

`scripts/agent-doctor.sh` is a single read-only diagnostic command that reports
which verification capabilities are available or blocked in the current
environment. It is diagnostic only:

- it never runs tests,
- it never starts services or browsers (the bounded Chromium launch preflight
  closes the browser before the doctor continues; nothing is left running),
- it never installs dependencies,
- it never mutates the working tree or any database (the only database
  statement executed is a read-only `SELECT 1`),
- it never sets `FG_ALLOW_E2E_RESET` and never touches the `fg_e2e` schema.

### Invocation

```text
./scripts/agent-doctor.sh          human-readable capability matrix
./scripts/agent-doctor.sh --json   stable machine-readable JSON (agents / CI)
./scripts/agent-doctor.sh --help   usage, status values, exit codes
```

The JSON mode has a fixed structure (`schema_version: 1`): `repo`,
`environment`, an ordered `capabilities` array (each capability has at least
`name`, `status`, `detail`), an `optional_capabilities` array, and a
`summary` block.

The last capability, `agent_observability` (local agent trace-capture
collector), is **optional**: it is reported but does not gate the result or
exit code, so a missing optional collector never turns a healthy product
environment into a failed doctor result. Set
`FG_DOCTOR_REQUIRE_OBSERVABILITY=1` to make it a required capability
(observability-required mode). Details: `docs/agent/OBSERVABILITY.md`.

### Status values

- `available` — the capability is present and works in this environment.
- `unavailable` — a required component or dependency is missing (installation
  would be needed; the doctor never installs).
- `blocked` — the component is present but unusable in this environment
  (sandbox/policy, failing browser launch, database auth failure, network
  policy). Known blockers are deliberately reported differently from missing
  dependencies.
- `unknown` — not determinable without mutation or extra context.

### Exit codes

- `0` — all **required** capabilities `available` (optional capabilities
  such as `agent_observability` do not gate the result unless
  `FG_DOCTOR_REQUIRE_OBSERVABILITY=1`).
- `1` — diagnosis completed; at least one required capability is `blocked`,
  `unavailable`, or `unknown`.
- `2` — usage error.
- `3` — internal doctor failure.

A blocked browser is **not** a successful E2E verification: the `e2e_gate`
capability is `available` only when the Chromium launch preflight succeeded and
the database is reachable. Otherwise the `e2e` profile cannot pass and must be
reported as blocked, not as verified.

### Environment budget after a detected blocker

The post-blocker environment budget (one normal attempt, at most one retry
after an immediately plausible, non-mutating diagnosis, then classify the
blocker and stop) is defined once in the canonical evidence contract:
`docs/agent/WORKFLOW.md` (Environment budget). No repeated install or launch
attempts.

### Doctor tests

`bash scripts/tests/agent-doctor.test.sh` covers the output formats, exit
codes, non-mutation, and simulated blockers (missing runtimes via restricted
PATH, missing browser via empty `PLAYWRIGHT_BROWSERS_PATH`, blocked-launch
classification and cause sanitization, optional-capability semantics). The
doctor is not part of any `agent-verify.sh` profile; run it directly.

## Agent observability (local, optional)

`./scripts/agent-observability` captures **native Codex OpenTelemetry** from
normal Codex/ACP agent sessions into a local, privacy-conscious,
git-ignored trace store (`.artifacts/agent-runs/`). It is a local capture
facility only: no dashboards, no external telemetry backend, no product or
Eval changes. Canonical documentation, privacy model, trace contract and
command surface: `docs/agent/OBSERVABILITY.md` and
`docs/agent/trace-contract.json`. Its own contract tests:
`bash scripts/tests/agent-observability.test.sh`.

## Living-Lab tasks

Core tasks:

### Task 1
Create a new Project and add Chris.

### Task 2
Create a Work Item for Chris inside that Project.

### Task 3
Chris finds the Work Item in My Work.

### Task 4
Chris opens the same Work Item in the Project Board.

### Task 5
Maria attempts to find/access the Project.

Expected:
```text
no access
```

Later Meeting tasks:

### Task 6
Create a Work Item from a discussed Weekly item.

### Task 7
Find the previous decision/history for an open Topic.

### Configuration: Task A — Default Project Configuration
Create a new Project. Verify it receives:

- TypeDefinitions: Epic, Milestone, Deliverable, Task
- StatusDefinitions: Todo (default), In Progress, Review, Done
- No labels initially
- Todo is the active default status (category `todo`)

### Configuration: Task B — Project Customization
As Project owner, add:

- Type: "Experiment"
- Status: "PI Review" (category: review)
- Label: "Reviewer Response"

Verify:
- A Project member may use these definitions on WorkItems.
- A Project viewer may read them but cannot configure them.

### Configuration: Task C — Project Isolation
Customize Paper XYZ with additional types, statuses, and labels.
Verify that another Project retains its own unchanged configuration.
No Definition may cross Project boundaries.

### Configuration: Task D — Custom Done Semantics
As Project owner, create:

- Status: "Accepted" (category: done)

Move a WorkItem from a non-done status to "Accepted".
Verify `completedAt` becomes populated.

Move the same WorkItem from "Accepted" to a status whose category is
`review`. Verify `completedAt` becomes null.

### Configuration: Task E — Status Category Immunity
Create a StatusDefinition and assign it to at least one WorkItem.
Attempt to change its semantic category.
Expected: rejected.
Rename remains allowed.

### Configuration: Task F — Deactivation
Deactivate a Type, Status, or Label that is referenced by at least one
WorkItem. Verify:

- The existing WorkItem retains its reference.
- The definition remains readable.
- The definition cannot normally be selected for new WorkItems.
- No automatic WorkItem mutation occurs.

### Configuration: Task G — Default Status Safety
Attempt to deactivate the active default status without first assigning
another valid active `todo` default.
Expected: rejected.

### Configuration: Task H — Privacy
A ResearchGroup admin without ProjectMembership attempts to inspect
the WorkItem configuration of a private Project.
Expected: no access.
Knowing Definition IDs must not bypass Project privacy.

### Configuration: Task I — Single Source of Truth
Verify the same WorkItem appears in:

- Project Work Items view
- My Work view

Both views must show the same WorkItem ID, same TypeDefinition, same
StatusDefinition, and same Labels. No projection-specific copies.

## Observed metrics

Per task, capture as useful:

- success/failure
- completion time
- misclicks
- questions
- visible uncertainty
- abandonment
- qualitative comments
- requested improvements

The purpose is to identify product and UX problems.

## Privacy and real data

A hosted Living Lab may process:

- names
- roles
- Project memberships
- tasks/work responsibilities
- Meeting notes
- decisions

Before using real research-group data, clarify:

- hosting
- access control
- institutional privacy requirements
- retention
- deletion
- backups

Use synthetic data until this is resolved.

## Hardening before real group use

Before real research-group use, ensure:

- reproducible deployment
- stable migrations
- seed/reset for test environments
- error handling
- authorization coverage
- backup approach
- privacy/hosting decision
- identifiable test version
