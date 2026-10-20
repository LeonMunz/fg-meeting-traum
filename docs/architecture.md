# FG Workspace — Architecture

## Technical target

```text
React Frontend
      ↓
REST API
      ↓
Django + Django REST Framework
      ↓
PostgreSQL
```

Architecture style:

```text
Modular Monolith
```

## Chosen stack

### Frontend

- React
- TypeScript
- Vite
- Tailwind CSS
- React Router

### Backend

- Python
- Django 5.2 LTS
- Django REST Framework

### Database

- PostgreSQL

### Python project management

- uv

These choices are deliberate Architecture Decision Gates. Changing them requires an explicit decision.

## Why backend is part of the Foundation

The product core depends on:

- authenticated users,
- Research Group membership,
- private Project membership,
- assignment between users,
- shared My Work,
- server-side authorization.

These cannot be represented as a durable multiuser architecture with localStorage or frontend-only state.

Shared persistence and server-side authorization therefore start during the Foundation rather than being a later migration.

## Repository target

```text
fg-meeting-traum/
├── apps/
│   ├── web/
│   └── api/
├── docs/
└── README.md
```

## Backend modular monolith

Target modules are introduced incrementally, not all at once:

```text
apps/api/
├── config/
├── accounts/
├── research_groups/
├── projects/
├── work_items/
└── meetings/
```

A module owns the domain code that belongs together, such as:

- models
- services/domain operations where needed
- permissions
- API endpoints/serializers
- tests

Do not create empty modules for future features merely to match this diagram.

## Frontend organization

Target direction:

```text
apps/web/src/
├── app/
├── components/
│   ├── layout/
│   └── ui/
├── features/
│   ├── projects/
│   ├── work-items/
│   ├── my-work/
│   ├── meetings/
│   └── research-group/
├── api/
├── domain/
└── lib/
```

Feature-specific UI belongs to its owning feature.

Cross-feature reuse should happen through a clear public feature interface once real reuse exists.

Avoid generic abstractions before at least two concrete use cases justify them.

### Shared Work Item presentation (`features/work-items/`)

The `work-items` feature owns the presentation that both Work Item
boards share — today the single Kanban card `WorkItemCard` (outer
surface and geometry, one-line ellipsis title, the concrete type as
text with machine-readable-kind coloring, Selected / Focus /
Dragging / Pending presentations, the complete exception
presentation — Blocked + due states — the optional assignee /
provenance metadata regions, and the top-right action-slot position
with its open/drag isolation guarantees) plus the pure due-date
presentation helpers. The Project Work Items Board
(`features/projects`) and the global My Work Kanban
(`features/my-work`) render their cards through it with thin
adapters over their own data sources, and keep everything
board-specific in their own controllers: permissions and the
shared delete action slot (board-level read-only on the Project
Board; per-item server-derived `actionPermissions.canDelete` from
the personal payload on My Work — never the open drawer's read-only
state, never a per-Project request), selection, drag tracking, and
the concrete reorder/refresh behavior. This is the canonical example
of the rule above: two concrete use cases justify the shared
presentation, and card-level visual changes happen in exactly one
place.

### Navigation & route transitions

- **Data router in production.** The production entry (`main.tsx`) uses the React Router data-router composition — `createBrowserRouter` + `RouterProvider` (from `react-router/dom`) — mounted through one shared composition (`DataRouterApp`) in which the global providers wrap `RouterProvider`. This is the rendering strategy that enables React Router's native View Transition integration for opted-in navigations.
- **One canonical route tree.** `appRoutes` (`app/routes.tsx`) is the single route configuration: the production data router and the declarative embedding (`useRoutes(appRoutes)`, used by the MemoryRouter-based test harnesses) render the same array, so routing behavior has exactly one source of truth.
- **Stable shell, transitioning content.** The AppShell chrome (Sidebar + TopBar) stays mounted across navigations and remains visually stationary. Only the routed application content — the AppShell `<main>` (`.fg-route-content`) — is the single named View Transition surface, and only that surface crossfades on an opted-in navigation.
- **Explicit opt-in.** A navigation participates in a View Transition only when opted in: declarative `Link`/`NavLink` use the `viewTransition` prop, and programmatic `navigate` calls pass `{ viewTransition: true }`. Non-opted-in navigation takes the ordinary path unchanged.
- **Restrained, safe motion.** The transition is one 150 ms opacity-only crossfade with standard easing. The document root snapshots are frozen and the opaque root snapshot always resolves to the canonical themed canvas, so no chrome blink and no blank or default-white frame can appear, in Light or Dark. With `prefers-reduced-motion: reduce` the crossfade is removed entirely and navigation stays immediate. Browsers without View Transition support never create the transition pseudo-elements; React Router falls back to the ordinary state-update path, with no JS animation substitute.
- **Stable destination loading.** Entering a workspace (e.g. a Project) renders a stable destination loading shell: the destination geometry and its canonical header surface are present from the first destination frame and the data resolves in place — never a blank replacement, a full-surface flash, or a page-level spinner.

### Workspace content width

- **Constrained ordinary content.** Ordinary (non-canvas) workspace content is rendered inside the shared `WorkspaceContent` frame (`apps/web/src/components/layout/WorkspaceContent.tsx`): fluid below the cap, centered in the available main-content area, capped at the single canonical width `--workspace-content-max-width` (80rem / 1280px, defined once in `apps/web/src/index.css`). Pages keep their own responsive horizontal/vertical padding around the frame; the frame owns width/centering only — no fixed pixel width, no new horizontal overflow.
- **Full-width canvas exemption.** Canvas-like workspaces (the Project Work Items Kanban board, future canvas-style views) remain full-width through the frame's explicit `variant="full"` — the exemption is an explicit per-page choice, never an accident of the shell.
- **AppShell is not globally constrained.** The AppShell `<main>` carries no max-width, so full-width boards never depend on a global shell change and constrained pages never force one on each other.
- **Stable contract handle.** `data-fg-workspace-content` (`constrained` | `full`) is the semantic marker that tests and tooling key off — never the Tailwind class string.
- **Incremental migration.** The Projects list and the Meetings list are the first migrated pages; the remaining pages adopt the shared frame in later slices. Implementation checkpoint: `docs/CURRENT_STATE.md` (Workspace content width contract).

## Frontend ↔ Backend boundary

```text
React Component
      ↓
Feature / API Layer
      ↓
HTTP
      ↓
DRF Endpoint
      ↓
Application / Domain Logic
      ↓
Django ORM
      ↓
PostgreSQL
```

React components do not access:

- PostgreSQL,
- Django models,
- localStorage as shared business persistence.

## Server state

Persisted business data remains server truth.

Local frontend state is appropriate for UI concerns such as:

- open drawer
- active tab
- filter selection
- form draft

Do not add a global state/query library until concrete complexity justifies it and the dependency is explicitly approved.

Once a backend endpoint exists for a business object, do not maintain a permanent parallel frontend mock source for the same behavior.

## Authentication

The early web Living Lab uses server-side Django authentication.

Target:

```text
Login
  ↓
server-verified identity
  ↓
authorized request
```

The authenticated identity is derived from the server request/session.

A client-provided `currentUserId` never establishes identity.

Early scope does not require:

- university SSO
- multiple OAuth providers
- identity federation

## Authorization

Authorization is server-side and deny-by-default.

Every protected operation checks access.

Collection/list endpoints are filtered so forbidden objects are not leaked.

Example:

```text
GET /projects

request.user
  ↓
valid ResearchGroupMembership?
  ↓
return only Projects with valid ProjectMembership
```

Hiding a React button is UX only, not authorization.

## API model vs database model

API shapes may expose convenient ID lists.

This does not imply storing foreign-key arrays in PostgreSQL.

Many-to-many relationships are modeled relationally with join models/tables where required.

Examples:

- WorkItem ↔ User → WorkItemAssignee
- WorkItem ↔ WorkItemLabelDefinition → WorkItemLabel (join table)
- Meeting ↔ User → MeetingParticipant
- WorkItem ↔ MeetingItem discussion → WorkItemDiscussion

Project-scoped WorkItem configuration (types, statuses, labels) uses
explicit relational domain models. No arbitrary JSON blob on Project.

## Single source of truth

Do not duplicate canonical relationships without a concrete technical reason.

Examples:

- `WorkItem.project_id` is canonical; do not also persist `Project.workItemIds`.
- `MeetingItem.meeting_id` is canonical; do not also persist `Meeting.meetingItemIds`.
- `MeetingItem.topic_id` is canonical; do not also persist `Topic.meetingItemIds`.

Derived views are queries/projections, not new domain stores.

## Development strategy

Build vertical slices.

Do not build:

```text
all database models
→ all endpoints
→ all frontend pages
```

Prefer:

```text
one domain capability
→ model/constraint
→ permission
→ API
→ minimal UI
→ tests
→ validate
```

Then extend the next capability.

## Roadmap

### Foundation 0 — Technical Bootstrap

Goal: frontend, backend, and database can run together.

Scope:
- existing React app
- Django app
- PostgreSQL
- migrations
- API connection
- health endpoint
- backend checks/tests
- frontend build/lint

No product-domain complexity yet.

### Foundation 1 — Identity & Research Group

- User
- login/session
- ResearchGroup
- ResearchGroupMembership
- current Research Group context
- seed data
- permission tests
- minimal UI

Acceptance:
> A logged-in user can access only a Research Group they belong to.

### Foundation 2 — Project & ProjectMembership

- create Project
- creator becomes Owner
- list/open Project
- add Project member
- owner/member/viewer
- private Project authorization

Acceptance:
```text
Alex sees X
Chris (Member) sees X
Maria (not added) does not see X
```

### Foundation 3 — Work Items

- WorkItemTypeDefinition (per Project)
- WorkItemStatusDefinition (per Project, with semantic category)
- WorkItemLabelDefinition (per Project)
- WorkItem with references to Project-scoped definitions
- status category (todo / in_progress / review / done)
- assignees
- due date
- blocked reason
- parent relationship
- Project Board

### Foundation 4 — Assignment & My Work

- WorkItemAssignee
- assignee permission checks
- My Work
- same canonical Work Item in My Work and Project Board

Then perform the Core checkpoint from `product.md`.

Meetings start only after that checkpoint.

## Realtime (Work Item invalidation transport — decided)

The earlier statement that Realtime is not needed was correct for the
Foundation phase and is superseded by the product decision below.

### Accepted product requirements

- Work Items exist exactly once; the Project Board, Project List, and My
  Work are views over the same canonical items.
- Project Kanban ordering is shared team-wide (`WorkItem.board_position`);
  My Work ordering is personal (`MyWorkBoardPosition`).
- Canonical status changes must be visible in both views.
- Other authorized users receive changes automatically, without a manual
  reload.
- The server remains the authoritative data source.
- Push events are invalidations only; they never transport Work Item
  copies.
- Multi-worker and multi-instance operation and client reconnection must
  be supported.

Canonical domain references: `docs/domain/foundation.md` §15 (Project
Board, shared `board_position`) and §14b (My Work Board ordering,
personal `MyWorkBoardPosition`).

### Decision: one authenticated SSE invalidation stream per tab

**Server-Sent Events (SSE)** over the existing Django/WSGI/Gunicorn stack:
one authenticated `text/event-stream` GET endpoint per browser tab.
Cross-worker and cross-instance fan-out uses **PostgreSQL
`LISTEN`/`NOTIFY`** on the already-deployed single PostgreSQL — no new
service, no new dependency.

Why this is the smallest architecture that satisfies every requirement
against the actual stack:

- **Django runtime.** SSE is a plain `StreamingHttpResponse` from an
  ordinary Django view. No ASGI, no Channels, no daphne/uvicorn, no new
  dependency (Django, DRF, Gunicorn, and psycopg are already the stack).
- **Proxy and topology.** Caddy already terminates the only public
  surface and already reverse-proxies `/api` to the private Gunicorn
  service; the pinned gateway (Caddy 2.11.4 in `deploy/Caddyfile`)
  needs no change for SSE — its reverse proxy flushes a streaming
  response immediately by default (see Required deployment changes).
- **Authentication.** A same-origin `EventSource` request carries the
  existing HttpOnly Django session cookie automatically; identity is
  derived from `request.user` through the standard middleware. No token
  or JWT, no new authentication surface — the authentication and session
  model is unchanged.
- **Multi-worker / multi-instance fan-out.** Every stream holds one
  dedicated PostgreSQL listener connection; a `NOTIFY` issued in the
  mutation's commit is delivered by PostgreSQL to every listening
  connection across workers and instances. No in-application bus, no
  sticky sessions, no shared memory, no Redis.
- **Semantics fit.** The product needs a one-way, lossy, self-healing
  invalidation hint. Browser `EventSource` provides automatic
  reconnection (native for regular interruptions; for terminal failures
  the client re-establishes the stream in a controlled manner — see the
  recovery contract); events invalidate and never carry state, so lost,
  duplicated, or out-of-order events self-heal through the
  authoritative refetch on (re)connect.
- **Failure mode.** A dead stream degrades to the currently validated
  behavior (canonical mutation + explicit refetch): no data loss, no
  divergence, the server stays authoritative.

### Rejected alternatives

- **WebSockets (Channels + ASGI server).** Requires a new ASGI server
  (daphne or uvicorn) replacing the Gunicorn WSGI entry point and the
  image's health contract, and the `channels` dependency. Cross-worker
  fan-out additionally requires `channels-redis` plus a Redis instance —
  new infrastructure and new dependencies, both out of scope for this
  slice. The bidirectional channel is unused: the client only receives
  invalidations.
- **HTTP long polling.** Each poll occupies a worker thread for the whole
  poll window (so it needs the same threaded-worker change anyway), adds
  client-side retry/jitter/correlation logic, has no native reconnect or
  event-ID semantics, and multiplies authenticated requests per client
  per interval. Strictly worse than SSE in every dimension.
- **Periodic client polling (timer-driven refetch).** Zero
  infrastructure, but constant background load per open tab, worst-case
  latency equal to the poll interval, and a stopgap rather than an
  architecture. It remains the documented degraded-mode behavior when the
  stream is unavailable.

### Event contract

**Stream lifecycle.** One user-scoped stream per browser tab:
`GET /api/work-items/events/` (proposed path; finalized in the
implementation slice). The server answers `200` with `text/event-stream`;
the first frame is an `open` handshake (`data: {"userId": <int>}`, the
connected user's own id). The server sends an SSE keep-alive comment
(`: ping`) every 15 s and closes the stream after 30 min; the browser's
`EventSource` reconnects transparently and re-authenticates on every
connection — that bounded re-authentication cycle is what caps how stale
authorization can get. Per the EventSource specification, a non-200
status — or a response whose Content-Type is not `text/event-stream` —
fails the connection at the response level: the `EventSource` moves to
`CLOSED` and the native layer does not reconnect from there. Such a
terminal failure is recovered by the client's controlled reconnection
instead (fresh authentication check via `GET /api/auth/me/` + bounded
backoff, see the recovery contract below); while the stream is down
the client shows the sync-paused state and relies on the ordinary
refetch paths.

**Event types and minimal payloads.**

| SSE event | Payload | Trigger | Client action |
|---|---|---|---|
| `open` | `{"userId": <int>}` | stream established | start reconnect bookkeeping |
| `work_item_changed` | `{"projectId": <int>}` | a committed mutation of that Project's Work Items: create, field update, status change, shared board reposition, assignee change, delete | one authoritative refetch of `GET /api/projects/<id>/work-items/` when that Project's Work Items surface is open |
| `my_work_changed` | `{}` | a change to the connected user's personal My Work projection: assignment added/removed, a canonical status change of an assigned item, or the user's own personal reorder from another tab/session | one authoritative refetch of `GET /api/me/work-items/` (persisted view state preserved) when My Work is open |

Events carry NO Work Item field, title, status, position, or other user
identity. An event is a scope pointer, not a data copy: nothing about an
inaccessible Project may become observable — not existence, not timing,
not content.

**Project-level vs user-level invalidation.** Shared data (Work Item
fields, shared `board_position`) is invalidated at project scope; personal
My Work data (assignments, personal `MyWorkBoardPosition`) at user scope.
One canonical mutation can emit both (a cross-category status transition
from My Work changes both the shared column and the actor's personal
projection). **Personal My Work reorder isolation:** a same-category
personal reorder touches only the acting user's `MyWorkBoardPosition`
rows and emits a personal event only — never a project event (it never
touches the canonical Work Item or `board_position`).

**Publication relative to the database commit.** Publication happens
inside the mutation's own transaction: `SELECT pg_notify('fg_work_items',
<payload>)` (channel name finalized in the implementation slice) runs in
the same `transaction.atomic()` block as the domain write — the same
durability contract as `AuditEvent` recording. PostgreSQL delivers the
notification on commit: a rolled-back mutation publishes nothing, a
committed mutation publishes exactly one notification per affected scope.
The payload is a few dozen bytes (scope + Project id / User id), far
below PostgreSQL's 8000-byte NOTIFY limit.

**Authorization at connection and during continued access.**
- Connection: the endpoint requires a live authenticated session
  (anonymous → 401; an inactive account also answers 401 — the standard
  AuthenticationMiddleware/ModelBackend combination maps an inactive user
  to anonymous; an explicit 403 `is_active` guard exists only as
  unreachable defense in depth, never as the standard answer). The stream
  itself grants no access.
- Per-delivery re-authorization (the revocation mechanism): every
  notification is re-authorized at delivery time against the connected
  user's CURRENT access, deny by default. Each delivery re-resolves two
  things: (a) identity — the connection's session still exists and the
  user is still active; (b) scope — a `work_item_changed` event for
  Project P is forwarded only while the user holds a valid current
  `ProjectMembership` (owner/member/viewer) on P — the identical
  canonical read boundary of the Work Item list endpoint — and a
  `my_work_changed` event only to the user it addresses. A lookup
  failure (deleted Project, malformed payload) fails closed: the event
  is suppressed, never forwarded.
- **Stopping unauthorized event delivery** (server-side guarantee,
  immediate at delivery time): once access to a scope is revoked, no
  further event for that scope is written to the affected user's stream,
  however many notifications arrive; other still-authorized scopes keep
  flowing on the same stream. This is the hard security boundary, and
  the one consequence of revocation that is immediate.
- **Invalidating the stale UI** (client-side, bounded, NOT immediate):
  the client is never told about the revocation — no event may name the
  lost scope, and nothing about an inaccessible Project may become
  observable. An already-open Project Board or My Work view therefore
  keeps its stale content until the next authoritative refetch of that
  surface. That refetch is guaranteed at the next (re)connection — the
  server closes the stream at the 30-minute limit, `EventSource`
  reconnects, and the client refetches its open surfaces — so the worst
  case for stale presentation is bounded by the stream limit, and an
  earlier user action (navigation, manual refresh) shortens it. The
  mechanism guarantees only a later reconciliation, never an immediate
  one; until the refetch lands, the revoked data stays unreachable
  through every canonical read, so the staleness is presentational
  only.
- **Closing or reauthorizing the existing stream:** a scope revocation
  does not close the stream — the stream grants no access, and closing
  it would be indistinguishable from a transport failure while
  needlessly degrading the user's still-authorized surfaces; the stream
  is reauthorized in place through the per-delivery checks. Only
  identity-level invalidation (session destroyed, user deactivated)
  closes the stream, at the next delivery; a subsequent reconnect of a
  dead session answers 401, which per the EventSource specification
  fails the connection at the response level (`readyState` `CLOSED`)
  without exposing the status to the client — the client never learns
  "401" from the stream itself. It learns it from the recovery
  contract's fresh authentication check (`GET /api/auth/me/`), which
  the terminal `CLOSED` triggers: that check's 401 is the terminal
  identity-level failure, the client stops scheduling controlled
  reconnects and treats the situation as an authentication loss
  (existing session state cleared, sign-in surface), and the stream
  resumes only after the user logs in again.

**Concurrent, duplicated, or out-of-order notifications.** PostgreSQL
`LISTEN`/`NOTIFY` is fire-and-forget: a notification is queued only for
the listener connections live at commit time, is never redelivered, and
has no ordering or deduplication guarantee — a stream that is
mid-reconnect at commit time misses that notification by design. The
client treats every event as an idempotent invalidation hint: it
coalesces repeated invalidations of the same scope (an in-flight refetch
or a short debounce yields one refetch), ignores events for scopes with no
open surface, and always refetches authoritative state — it never applies
state incrementally from event data. Duplicated, out-of-order, or missed
events all converge to the same correct state, because state is fetched,
never assembled from events.

**Recovery contract (reconnection and authoritative refetch).** The
stream is stateless: there is no backlog replay and `Last-Event-ID` is
not used for recovery. Reconnection has exactly two tiers:

- **Regular interruption — native EventSource reconnect.** A
  connection-level interruption (network error, dropped connection, or
  the server-initiated 30-minute close) leaves the browser's
  `EventSource` in `CONNECTING`; per the EventSource specification it
  retries on its own after the reconnection time (default 3 s). The
  client neither creates a new `EventSource` for such interruptions nor
  layers its own backoff on top of the native retry — the native
  reconnection IS the recovery for this tier.
- **Terminal failure — controlled new EventSource.** A response-level
  failure sets `readyState` to `CLOSED` — in particular a non-200
  response (e.g. the 5xx overload answer) or a non-`text/event-stream`
  Content-Type before stream bytes — and the native layer never retries
  from `CLOSED`. The client's reconnection controller (owned with the
  stream's lifecycle) then creates a NEW `EventSource` in a controlled
  manner: the closed instance is dropped and never reused. Two guards
  make this loop-safe:
  - **Fresh authentication check — the auth gate.** The client can
    never read a failed status code off the stream: per the EventSource
    specification, the `error` event of a response-level failure
    carries no HTTP status and no response body — a 401 (anonymous /
    dead session), a 403 (inactive user), and a 5xx overload answer
    are indistinguishable at the client level; each of them is just a
    terminal `readyState` `CLOSED`. The gate therefore never infers
    identity loss from the stream error, and an SSE 403 is never
    presented as readable from `onerror`. On the terminal `CLOSED`
    the client performs a fresh authentication check with the existing
    `GET /api/auth/me/` endpoint (the same endpoint the app recovers
    its session state from) before creating the new `EventSource`,
    and acts on the check's own answer:
    - **401 — authentication loss.** The server-side session is gone:
      a destroyed or dead session answers 401 here, and an inactive
      user answers 401 as well (`IsAuthenticated` gate). The client
      stops scheduling controlled reconnects entirely — no new
      `EventSource` is ever created, no further controlled attempt is
      scheduled — and treats the situation as an authentication loss
      through the app's existing session state (cleared, as on
      explicit logout), so the user signs in again through the
      ordinary sign-in flow.
    - **200 — session valid.** The client proceeds with the
      controlled reconnect under the backoff below; the terminal
      failure itself stays unclassified (overload 5xx, inactive-user
      403, and other non-200 answers are indistinguishable at this
      level) and is treated as a transport failure.
    - **Network error / 5xx on the check — inconclusive.** The client
      does NOT log the user out and does NOT treat the stream failure
      as identity loss; it schedules the next controlled attempt under
      the backoff and repeats the fresh check before it.
    The gate is preceded by the app's existing local session state: if
    the app has no authenticated session at all (explicit logout,
    unauthenticated first load), no fresh check for the stream is
    issued, no `EventSource` is created, and no attempt is scheduled;
    the client stays sync-paused until the user authenticates.
  - **Exponential backoff with jitter and cap.** Controlled attempts are
    spaced by exponential backoff with randomized jitter, capped:
    attempt n (n >= 1) waits a uniformly random delay in
    `[0, min(cap, base x 2^(n-1))]` with `base` = 1 s and `cap` = 30 s
    (client constants of this contract). The attempt counter counts
    controlled (terminal-tier) attempts only — native retries of the
    first tier do not advance it — and resets to 0 when a connection
    succeeds (the `open` handshake).
- **Authoritative refetch after every successful (re)connection.**
  Whichever tier re-establishes the stream — initial connect, native
  reconnect, controlled reconnect, or reconnect after a server restart —
  the client refetches the surfaces it currently shows once it observes
  the `open` handshake; that refetch is the complete recovery mechanism,
  and the client never applies state incrementally from event data
  (coalescing and surface-scoping rules unchanged).
- **Presentation and degraded mode.** While the stream is down — native
  reconnection in flight or backoff wait — the client shows a subdued
  sync-paused state (no error spiral). A persistent terminal failure —
  the stream keeps failing while the fresh check keeps answering 200,
  e.g. sustained overload or an SSE 403 that the client cannot read
  out of `onerror` — is bounded by design: the backoff saturates at
  its cap, and only the fresh check's own 401 can trigger the
  authentication-loss path, so no stream failure ever logs the user
  out. If the transport stays unavailable, the product degrades to
  its pre-realtime behavior: canonical mutations plus explicit
  refetch — no data loss, no divergence, the server stays
  authoritative.

**Verifiable criteria for the client slices** (implemented by RT-04 /
RT-05, verified in E2E by RT-06):

1. **RC-1 — native reconnect for regular interruptions.** A
   connection-level interruption (mocked `error` with `readyState`
   `CONNECTING`, or the 30-minute close) is recovered by the native
   reconnection of the SAME `EventSource` instance: no new instance is
   constructed and no client-side delay is added on top of the native
   retry.
2. **RC-2 — controlled reconnect for terminal failure.** A mocked
   response-level failure (`readyState` `CLOSED`, e.g. a 5xx response
   before stream bytes — the mock carries no readable status, and the
   contract never assumes one does) causes the reconnection controller
   to issue the fresh `GET /api/auth/me/` check first; with the check
   mocked to 200 it then constructs exactly one new `EventSource`
   after the backoff wait; the closed instance is dropped and never
   reused.
3. **RC-3 — backoff bounds.** Under fake timers, the scheduled delay of
   controlled attempt n lies in `[0, min(30 s, 1 s x 2^(n-1))]`, the
   waits grow exponentially up to the 30 s cap, native retries do not
   advance the counter, and the counter resets to 0 after a successful
   `open` handshake.
4. **RC-4 — fresh auth check, no invalid-session loop.** After a
   terminal `CLOSED` the fresh `GET /api/auth/me/` check gates every
   controlled attempt: mocked 401 — no `EventSource` is constructed,
   no further controlled attempt is scheduled, and the app's existing
   authentication-loss handling runs (local session state cleared);
   mocked 200 — the controlled attempt proceeds under the backoff;
   mocked network error / 5xx — no logout, and the check repeats
   before the next attempt. With the app's authentication state
   already unauthenticated (explicit logout), no stream `EventSource`
   is constructed and no stream request is made.
5. **RC-5 — refetch on every successful (re)connection.** Each of:
   initial connect, native reconnect after an interruption, controlled
   reconnect after a 5xx, and reconnect after a simulated server
   restart — observed via the `open` handshake — triggers exactly one
   authoritative refetch per open surface (Project Board:
   `GET /api/projects/<id>/work-items/`; My Work:
   `GET /api/me/work-items/`, persisted view state preserved).

### Multi-worker and multi-instance operation

- Each SSE stream runs in one request thread of any Gunicorn
  (`gthread`) worker and holds one dedicated PostgreSQL listener
  connection (`LISTEN`) for its lifetime. The listener connection is
  the stream's own connection — not the Django request connection (the
  deployment uses the default `CONN_MAX_AGE = 0`). The per-request
  connection that authenticates the stream is not released before the
  stream blocks: it stays open for the stream's whole lifetime (it is
  the connection the per-delivery re-authorization queries run on) and
  is released when the WSGI server closes the response — in the
  stream's own final cleanup path, together with the dedicated listener
  connection (Gunicorn gthread closes the response after the body loop
  ends or after a write failure; the Django WSGI path releases the
  per-request connection only through the `request_finished` →
  `close_old_connections` that response close fires). The capacity
  formula below is unaffected: its `W x T` term already counts one
  request connection per thread, streaming threads included.
- The publisher's in-transaction `pg_notify` is delivered by PostgreSQL
  to every listening connection — across workers and across instances,
  since they all share the single PostgreSQL. No in-application bus, no
  sticky sessions, no shared memory, no Redis. The `pg_notify` runs on
  the mutation's own transaction connection and consumes no additional
  connection.
- Worker recycling or crashes kill the streams they hold; PostgreSQL
  releases the dead listener connections when their sockets close;
  clients reconnect to a healthy worker and refetch.

### Capacity model (no unsupported limits)

- **Execution slots.** A live stream occupies one worker thread for its
  whole lifetime (the stream generator blocks reading its listener
  connection). Under the current entry point (default: one `sync`
  worker, one thread) a single open stream would block every other API
  request — including the container healthcheck — which is why the
  threaded worker is the required deployment change. Sizing rule: per
  worker, `T` (threads) must cover the expected concurrent streams on
  that worker plus an ordinary-request headroom `R` that never drops to
  zero (`T >= S_per_worker + R`, `R >= 1`). The architecture fixes no
  magic `T`: RT-02 sizes `T` (and, if chosen, the worker count `W`)
  for the expected concurrent stream count and records it with the
  deployment.
- **Database connections.** Every live stream holds one dedicated
  listener connection, and those count against `max_connections`
  alongside the ordinary per-request connections (one per in-flight
  request, opened and closed per request; no pooling by default). The
  worst-case concurrent requirement is:

      S + W x T + M <= max_connections

  with `S` = concurrent live streams across all workers and instances,
  `W` = Gunicorn worker processes, `T` = threads per worker, `M` =
  operational margin (migrations, `psql`, healthchecks). Example at
  the defaults (`max_connections` = 100, `W` = 1, `T` = 32): at most
  `S = 100 - 32 - M` concurrent streams. That is a calculation, not a
  guarantee — the architecture claims no specific `max_connections`
  value is safe; the deployed sizing must satisfy the formula.
- **Scale-up order** when the formula gets tight: (1) a per-worker
  shared listener with in-process fan-out to the worker's own streams
  (listener connections drop from `S` to `W`); (2) raising
  `max_connections`; (3) Redis pub/sub only as a separately approved
  architecture decision (new dependency).
- **Cleanup on disconnect.** A client disconnect (tab closed, network
  loss) must release both resources: in the default proxy mode, Caddy
  cancels the upstream request when the client goes away, the Gunicorn
  write to the dead client fails (with the 15 s keep-alive, at the
  latest one keep-alive interval after the disconnect), and the
  gthread worker then closes the response iterator — the stream
  generator receives `GeneratorExit`, and its cleanup path closes the
  dedicated listener connection. This cleanup path is a hard
  requirement of the RT-03A implementation and carries its own
  integration test (force a client disconnect; the database connection
  count returns to baseline).
- **Overload and failure response.** If a stream cannot be opened
  (listener connection refused: connection exhaustion or database
  unavailable), the endpoint answers 5xx *before* any stream bytes —
  never 204, which would be indistinguishable from a permanent close.
  Per the EventSource specification a non-200 response fails the
  connection natively (`readyState` `CLOSED`); the recovery contract's
  controlled reconnection then takes over under its fresh
  authentication check (`GET /api/auth/me/`) and bounded exponential
  backoff, so an overload produces no retry storm — the wait before
  each attempt grows exponentially up to the cap, and the check stops
  attempts entirely once it answers 401 (authentication loss). While
  the stream is down the client stays in the sync-paused degraded state
  (canonical mutation + explicit refetch); the stream reopens on the
  first healthy controlled attempt, and a page load or app navigation
  that remounts the surface reopens it independently. A per-delivery
  authorization or lookup failure fails closed per event (suppress) and
  never blocks the stream. The stream claims no durability: a
  notification missed because the listener was down is not redelivered;
  the refetch on (re)connection is the recovery.

### Required deployment changes

1. **API image entry point:** add `--threads <N>` (and, if the operator
   chooses, `--workers`) to the existing Gunicorn command. Gunicorn
   (pinned 23.x) resolves the default `sync` worker class to its
   built-in `gthread` worker class automatically whenever `--threads`
   > 1 — no new dependency, and the startup log reports `Using worker:
   gthread`. `N` is sized by the capacity model above (concurrent
   streams + ordinary-request headroom per worker); it is an
   operator-tunable constant of the deployment, not an architecture
   constant, and it is recorded in the entry point.
2. **Caddy gateway: no change.** The pinned gateway is Caddy 2.11.4.
   Its reverse proxy performs no periodic flushing by default and,
   more importantly, flushes a response immediately as soon as it
   recognizes a streaming response — the response's `Content-Type` is
   `text/event-stream`, or its Content-Length is unknown; a Django
   `StreamingHttpResponse` satisfies both. No `flush_interval`
   directive is therefore added to `deploy/Caddyfile` — and none could
   be added to the image-level `apps/web/Caddyfile`, which
   deliberately contains no `/api` reverse proxy at all (it answers
   404 for `/api`; the deploy Caddyfile replaces that behavior). An
   explicit `flush_interval -1` is deliberately NOT set: in that
   low-latency mode Caddy does not cancel the backend request when the
   client disconnects early, which would orphan the stream thread and
   its dedicated listener connection until the 30-minute close and
   break the cleanup-on-disconnect contract. The only proxy-facing
   requirement is a backend one: the stream response must declare
   `Content-Type: text/event-stream` — the same header the browser
   `EventSource` requires to keep the connection open at all.
3. **Nothing else:** no Redis, no new container, no new network, no
   PostgreSQL configuration change (`LISTEN`/`NOTIFY` is built in), no
   new dependency. Development (`runserver`) needs no change.

### Integration test strategy

Deterministic in-process integration tests (Django test runner, no
browser) using the Django test client for the stream and raw psycopg
connections for publishing and listening:

- Connection authorization: anonymous 401, inactive user 401,
  authenticated user `200` + `text/event-stream` + the `open` handshake.
- Publication: each committed Work Item mutation publishes exactly one
  notification per affected scope; a rolled-back mutation (simulated
  post-write failure, the existing audit-event test pattern) publishes
  nothing.
- Delivery and non-leakage: a Project member — including a viewer —
  receives the project event; a user without ProjectMembership receives
  nothing (no existence or timing leak); a revoked membership suppresses
  delivery; a malformed payload is suppressed (fail closed).
- Fan-out: two independent `LISTEN` connections both receive the same
  notification (simulating two workers); in-worker delivery through the
  streaming response.
- Scope correctness: same-category personal reorder emits a personal
  event only; a cross-category personal move emits personal + project
  events; assignee add/remove emits the project event plus one personal
  event per affected assignee.
- Revocation (the security boundary): after a `ProjectMembership` is
  revoked, a committed mutation on that Project writes nothing to the
  affected user's stream while a sibling member's stream still receives
  the event; the affected user's stream stays open and keeps delivering
  other still-authorized scopes (scope revocation never closes the
  stream). After the stream's session is destroyed (or the user
  deactivated), the next delivery closes the stream, and a reconnect
  attempt answers 401 — fatal to `EventSource` per spec (`readyState`
  `CLOSED`, no status exposed to the client); the client-side
  consequence — the fresh check answering 401 stops all controlled
  reconnects (auth loss) — is a client contract (RC-4), asserted by
  the client unit tests, not by this server-side suite.
- Cleanup on disconnect: force a client disconnect on an open stream;
  the stream thread terminates and the dedicated listener connection is
  closed (the database connection count returns to baseline).

Browser E2E (acceptance, later slices). Environment: a TLS-terminating
surface and a browser-capable host terminal per the browser-execution
gate. The current local Compose topology cannot host these checks — it
is loopback HTTP, and the production settings contract (`SECURE_*`
cookies, HTTPS-only `CSRF_TRUSTED_ORIGINS`) makes browser login
impossible there; that restriction binds browsers, not scripts, which
is why the loopback verification vehicle (the RT-03A scripted-client
check in the implementation sequence) is a scripted non-browser client
holding an operator-provisioned session cookie.
Checks: two users — a Project Board drag by user A appears on user B's
board without manual refresh; a My Work reorder in one tab appears in
the other; permission revocation — no further event for the revoked
scope reaches the client, and the next authoritative refetch (user
action, or a forced reconnect under a shortened stream cap in the
test) re-renders from the canonical permission-filtered read; a forced
API restart reconnects and refetches correctly.

### Implementation sequence (RT-02, RT-03A, and RT-03C implemented — see `docs/CURRENT_STATE.md`)

1. **RT-02 — transport prerequisite (deployment only).** Add
   `--threads <N>` (sized by the capacity model) to the API image
   Gunicorn entry point. No gateway change: no `flush_interval`
   anywhere, `deploy/Caddyfile` untouched, `apps/web/Caddyfile` stays
   deliberately proxy-free. Acceptance — all executable in a
   deployment-only slice, with no stream endpoint involved: the
   production topology boots, the api healthcheck is green, the SPA
   and `/api` are served, and the Gunicorn startup log reports
   `gthread` with the thread count recorded in the deployed entry
   point. Long-connection behavior (a stream staying open beyond 60 s
   while concurrent API requests are served) is NOT accepted here — no
   stream endpoint exists in a deployment-only slice — and moves to
   RT-03A, where the endpoint it exercises exists. Dependencies: none.
2. **RT-03A — transport foundation (IMPLEMENTED).** The SSE endpoint
   with connection authorization (anonymous/inactive → 401 before any
   stream bytes; failed listener connection → 503 before any stream
   bytes), the dedicated per-stream PostgreSQL `LISTEN` connection,
   per-delivery re-authorization (scope + session validity), the
   `text/event-stream` response contract (`open` handshake, 15 s
   keep-alive, 30-minute limit), the cleanup-on-disconnect path, and a
   small internal in-transaction `pg_notify` publication interface
   (commit-attached; the project-scoped wiring of the canonical
   mutation services landed in RT-03C, the personal publisher is not
   yet wired).
   Production Work Item mutations publish no events in this slice.
   Acceptance: the transport integration test suite above (real
   transactions + real listener connections), plus — in the deployed
   production topology with a scripted non-browser client (the loopback
   surface can authenticate scripts, not browsers) — a stream stays
   open beyond 60 s while concurrent API requests are served normally,
   and a forced client disconnect returns the database connection
   count to baseline. Dependencies: RT-02.
3. **RT-03B — production publication wiring (partially implemented:
   the project scope in RT-03C, the personal scope still pending).**
   In-transaction `pg_notify` in the canonical Work Item mutation
   services (create, update, reposition, status transition, delete,
   assignee change, personal reorder) through the RT-03A internal
   publisher — each committed mutation publishes exactly one
   notification per affected scope, a rolled-back mutation publishes
   nothing — plus the scope-correctness tests: same-category personal
   reorder emits a personal event only; a cross-category personal move
   emits personal + project events; assignee add/remove emits the
   project event plus one personal event per affected assignee.
   Dependencies: RT-03A. **RT-03C (implemented):** the PROJECT scope of
   this item — every committed canonical Project Work Item mutation
   (create, real update — including a real label-set change, delete,
   real board reorder, real status transition, assignee change through
   the update path) publishes exactly one `work_item_changed` for the
   affected Project inside the mutation's own transaction (rollback →
   nothing; failed mutation / failed authorization / genuine no-op →
   nothing; nested service calls — e.g. the cross-category My Work
   move through `transition_work_item_status` — publish no duplicate;
   a same-category personal My Work reorder touches no canonical Work
   Item state and publishes no project event; the Project id always
   comes from the server-authorized canonical state). Pinned by
   `apps/api/work_items/tests_realtime_mutations.py` (real
   transactions + real dedicated LISTEN connections + real SSE
   streams). **Still pending (the remainder of RT-03B):** the personal
   `my_work_changed` emission (assignment add/remove, a canonical
   status change of an assigned item, a personal reorder) —
   `publish_my_work_changed` is not yet called by production code, so
   the FULL RT-03B domain integration is not complete.
4. **RT-04 — Project Board client integration.** `EventSource` lifecycle
   on the Project detail page (open on board mount, close on unmount),
   including the client recovery contract (RC-1…RC-5) for the
   board's `EventSource`; one authoritative refetch on
   `work_item_changed` for the open project, reusing the existing
   silent reconciliation; an in-flight optimistic drag is never
   clobbered by an event-triggered refetch. Acceptance: unit tests
   (incl. RC-1…RC-5) + cross-user board-sync browser E2E (on a
   TLS-terminating surface — the current loopback topology cannot
   authenticate a browser; see the E2E environment note).
   Dependencies: RT-03B.
5. **RT-05 — My Work client integration.** One authoritative refetch on
   `my_work_changed` with persisted view state preserved; the My Work
   stream implements the same client recovery contract (RC-1…RC-5).
   Acceptance: unit tests (incl. RC-1…RC-5) + cross-tab E2E (same
   TLS-terminating surface requirement). Dependencies: RT-03B
   (independent of RT-04).
6. **RT-06 — cross-surface and reconnect verification.** E2E: two users,
   cross-tab My Work, forced reconnect (both recovery tiers: native
   reconnect after a regular interruption, and the controlled
   new-`EventSource` reconnect after a terminal 5xx, including the
   fresh-check 401 terminality (no further controlled reconnect,
   authentication loss)), permission revocation (delivery stops
   for the revoked scope; the stale UI reconciles at the next
   authoritative refetch), and degraded mode with the stream blocked.
   Acceptance: E2E suite + production-topology runbook note.
   Dependencies: RT-04, RT-05.

## Architecture Decision Gates

Make an explicit decision before:

- adding a runtime dependency
- adding a state/query management library
- changing backend framework
- changing database
- changing authentication strategy
- changing permission model
- changing a major domain invariant
- introducing realtime
- introducing generic abstractions
- adding external integrations
- changing build tooling
- changing deployment architecture

## Source-of-truth layers

Different concerns have different authoritative forms:

- Product meaning/scope → `docs/product.md`
- Domain semantics/invariants → `docs/domain/`
- Technical architecture → this document
- Persistence implementation → Django models + migrations
- API contract → DRF serializers/endpoints
- Frontend contract representation → TypeScript types

When these disagree, do not silently patch around the mismatch. Resolve it deliberately.
