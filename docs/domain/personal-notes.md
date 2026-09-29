# FG Workspace — Personal Notes Domain

This document is the canonical domain reference for **Personal Notes**
(the *Personal → Notes* private capture space).

Companion documents:

- `docs/domain/foundation.md` — Identity, Research Group, Project,
  Membership, Work Item semantics (what Notes are NOT).
- `docs/domain/authorization.md` — Membership & Authorization
  (explicitly does NOT apply to Personal Notes — ownership is the
  only gate, §8 below).
- `docs/domain/meetings.md` — Meetings domain (Meeting Notes are a
  different concept, see §3).
- `docs/architecture.md` — technical architecture.

The invariants below are **settled decisions**. Code that contradicts
this document is an implementation defect.

## 1. Purpose and dominant invariant

A Personal Note is a **private, personal capture**. It exists for the
owner alone, for capturing thoughts, drafts, and context.

The dominant invariant:

> **A Personal Note belongs to exactly one user and is readable and
> writable only by that user.**

Notes are private by default and private *absolutely*: there is no
sharing, no group visibility, no project visibility, and no later
"make public" path in V1.

## 2. Ownership

1. Every Personal Note has exactly one **owner**: the authenticated
   user who created it (`PersonalNote.user`).
2. **Ownership is immutable after creation.** No domain operation
   accepts or applies a change of owner. There is no transfer, no
   reassignment, no delegation.
3. The creator is always the owner; identity comes from the
   authenticated server session/request, never from a client-supplied
   user id.
4. **There is no authorization fallback.** No `ResearchGroupMembership`,
   `ProjectMembership`, Meeting participation, or any other relationship
   grants read or write access to a note that the actor does not own.
   A user's Research Group or Project access has **zero effect** on
   another user's notes.

## 3. Notes are NOT Work Items

A Personal Note is personal capture, not project work:

- a Personal Note has **no Project** and belongs to no Project;
- it has **no** Work Item type/status/label definitions, **no**
  assignee, **no** due date, **no** board position;
- it is **never** counted as a Work Item in My Work, Boards, Activity,
  or any Work Item read model;
- Meeting **Notes** (`MeetingNote`, protocol context on a MeetingItem,
  see `docs/domain/meetings.md`) are a different domain concept and
  must not be conflated with Personal Notes.

Later phases may add an explicit *Convert to Work Item* action; until
then no relation of any kind exists between the two.

## 4. Owner-scoped lookup rule

Every domain operation that addresses an existing note MUST scope the
lookup by **note id AND current actor/owner** in a single query —
e.g. `filter(user=actor, pk=note_id)`.

- `PersonalNote.objects.get(pk=note_id)` followed by a later ownership
  check is **forbidden**.
- A **nonexistent** note id and **another user's** note id produce the
  **same** domain outcome ("not found / inaccessible") and must never
  reveal which condition occurred.
- Listing operations are owner-scoped querysets: a user's list can
  never contain another user's notes.

## 5. Active vs. archived state

Archive state is the single persisted fact `archived_at`:

- `archived_at IS NULL` → the note is **active**.
- `archived_at IS NOT NULL` → the note is **archived** (the value is
  the moment it was archived).

Semantics:

1. **Normal listing** returns only active notes. The **archived
   listing** returns only archived notes. The two sets are disjoint.
2. **Archiving** sets `archived_at` and retains title, content,
   pinned state, and ownership. Archiving **never deletes the row**.
3. **Restoring** clears `archived_at` on the **same row**: the note
   keeps its id and all other fields and becomes active again.
4. Archiving and restoring are **idempotent**: a note already in the
   requested state is left completely unchanged (no new timestamp, no
   state churn).

There is no Trash / permanent-delete lifecycle in V1 (see §11).

## 6. Pin semantics

`pinned` is lightweight personal state on the note itself:

- it is a boolean owned by the note's owner, set by the owner only;
- it does **not** change ownership;
- it does **not** imply visibility to anyone else (notes stay private);
- it does **not** create another entity (no separate pin record);
- pinned segmentation of the Notes UI is a later API/UI composition
  concern — the domain only persists the flag.

## 7. Title and content

- **Capture-first:** a note may be created with an **empty title** and
  **empty content**. No domain rule requires organizational metadata
  before a row can exist; a title may start empty and be derived later.
- `title` is short text (max 255 chars); `content` is **plain textual
  content** (`TextField`). No editor-specific JSON or other storage
  format is introduced; a later editor slice decides how its format
  maps onto this canonical textual field.

## 8. No Research Group / Project permission inheritance

Personal Notes are outside the Research Group / Project authorization
model entirely:

- the `authorization` capability system is not a gate for notes —
  **ownership is the only gate**;
- adding, removing, or changing any membership of the owner or of any
  other user never changes note access;
- group- or project-level views must **never** expose another user's
  notes (the same rule that forbids leaking private project data
  through group-level meeting views).

## 9. Ordering contract

Owner-scoped reads use one deterministic domain ordering:

1. **most recently updated first** (`updated_at` descending);
2. **tie-break by id** (higher id first — among otherwise equal
   recency, the later-created note comes first).

Any persisted change to a note (title/content update, first archive,
restore, pin state change) updates `updated_at`; an idempotent no-op
replay does not. No second persisted ordering system (no folders, no
manual positions) exists or may be introduced in this slice.

## 10. HTTP API (core lifecycle — implemented)

The Personal Notes domain is exposed through an authenticated REST
API under `/api/me/notes/`. The HTTP layer is a THIN boundary: it
authenticates, validates the transport shape, and delegates
ownership resolution and every mutation to the canonical service
layer (§11). It contains no authorization logic of its own and
never queries notes unscoped. `PersonalNoteNotFoundError` — the
single non-leaking domain outcome for BOTH an unknown note id and a
foreign note id — maps to one identical `404` body
(`{"error": "Personal note not found."}`) in every endpoint.

### Endpoints

| Method & path                     | Behavior                                                            |
| --------------------------------- | ------------------------------------------------------------------- |
| `GET /api/me/notes/`              | The current user's ACTIVE notes, canonical ordering (§9); optional `?q=` search (see Search below). |
| `POST /api/me/notes/`             | Create one note owned by the current user (`201`).                  |
| `GET /api/me/notes/archive/`      | The current user's ARCHIVED notes, canonical ordering (§9).         |
| `GET /api/me/notes/{noteId}/`     | One of the current user's notes (active or archived).               |
| `PATCH /api/me/notes/{noteId}/`   | Partial update of `title` and/or `content` only.                    |
| `POST /api/me/notes/{noteId}/pin/` | Set pin state: `{"pinned": true \| false}` (required boolean).    |
| `POST /api/me/notes/{noteId}/archive/` | Archive the note (idempotent; never deletes).                |
| `POST /api/me/notes/{noteId}/restore/` | Restore the note (idempotent; same row, same id).             |

Every endpoint requires authentication; anonymous requests receive
the repository's canonical `401` (`WWW-Authenticate: Session`).
Mutating endpoints follow the repository's canonical
browser-mutation CSRF contract (DRF `SessionAuthentication` CSRF
enforcement for authenticated unsafe requests — see
`docs/domain/authentication-sessions.md` §7).

NOT part of this contract: `DELETE`, a separate search endpoint
(`GET /api/me/notes/search/` — search is the `?q=` parameter on the
active listing only), Daily Notes, Work Item / Meeting relations,
Convert to Work Item, sharing, and tags/folders.

### Search (``?q=`` on the active listing — implemented)

``GET /api/me/notes/`` accepts the optional ``q`` query parameter.
V1 search is a simple case-insensitive substring search over the
current user's **ACTIVE** notes only:

- a note matches when ``q`` occurs in its **title OR content**;
- matching is **case-insensitive**; there is NO tokenization,
  stemming, relevance ranking, or special search syntax;
- only **transport-level whitespace** is trimmed from ``q``: an
  absent ``q`` and an effectively empty (whitespace-only) ``q``
  behave EXACTLY like the ordinary active listing;
- **archived notes never match** — the search base is
  ``archived_at IS NULL`` only, and the archive listing
  (``GET /api/me/notes/archive/``) does not gain search;
- the **canonical ordering** (§9) is retained: most recently
  updated first, id tie-break;
- search is **owner-scoped in the query itself**: the predicate is
  applied in one query that starts from the authenticated user
  (``user = <request user>``) AND ``archived_at IS NULL``. No
  Research Group / Project / Meeting membership of any kind grants
  search visibility (§8), and a search answer never reveals the
  existence of another user's notes (no counts, no errors);
- the response uses the unchanged note representation below — no
  highlights, excerpts, relevance scores, or owner fields;
- the view delegates to the canonical service
  ``search_active_notes`` (``personal_notes.services``); there is
  no separate search endpoint.

### Note representation

Every read and write answer carries the same full note
representation (camelCase):

```json
{
  "id": 1,
  "title": "string",
  "content": "string",
  "pinned": false,
  "archivedAt": null,
  "createdAt": "2026-09-29T12:00:00.000000Z",
  "updatedAt": "2026-09-29T12:00:00.000000Z"
}
```

`archivedAt` is `null` exactly while the note is active. The
representation exposes NO `user` / `userId` / `owner` or other
owner identifier: the owner is the authenticated user by
construction and the payload must not leak it.

### Create / update / lifecycle contracts

- **Create** accepts `{"title"?: string, "content"?: string}`; both
  are optional (an empty object is valid and creates `title = ""`,
  `content = ""`). `title` is validated against the §7 max-length
  constraint; an over-length title is rejected (`400`) with nothing
  persisted. The owner is always `request.user`; client ownership
  fields (`user` / `userId` / `user_id` / `owner` / `ownerId` /
  `owner_id`) are rejected fail-closed (`400`) — they can never
  create or imply an ownership contract.
- **Update** (PATCH) accepts a subset of `{"title"?: string,
  "content"?: string}` (partial update). `owner`, `pinned`,
  `archivedAt`, `createdAt`, and `updatedAt` are NEVER directly
  mutable and are rejected fail-closed (`400`); pin and archive
  lifecycle use their explicit action endpoints. An empty PATCH is
  a valid no-op: nothing is persisted and `updatedAt` is not
  churned. A valid persisted change updates `updatedAt` (see §9).
- **Pin** requires exactly one boolean `pinned` (missing or
  non-boolean → `400`). Setting the already-current state persists
  nothing (no `updatedAt` churn).
- **Archive / restore** delegate directly to the idempotent domain
  services: a repeated archive or restore leaves the row —
  including `archivedAt` and `updatedAt` — completely unchanged.
  Archive never deletes the row; restore clears `archived_at` on
  the SAME row (the note keeps its id).

## 11. Persisted fields in this slice

The V1 persisted foundation is exactly:

| Field         | Persistence                                   |
| ------------- | --------------------------------------------- |
| `id`          | surrogate primary key                          |
| `user`        | FK to the authenticated User — the owner       |
| `title`       | text, max 255, may be empty                    |
| `content`     | textual content, may be empty                  |
| `pinned`      | boolean, default false                         |
| `archived_at` | timestamp, NULL = active                       |
| `created_at`  | timestamp, set once at creation                |
| `updated_at`  | timestamp, updated on persisted changes        |

### Explicit exclusions (later phases — NOT implemented)

- Daily Notes support (`daily_date` and daily-note semantics)
- Work Item relations and *Convert to Work Item*
- Meeting relations
- tags, folders
- sharing, permissions/ACLs
- comments, version history
- AI fields
- task/status/due-date/assignee fields
- Trash / soft-delete (`deleted_at`) lifecycle
- any Notes UI (route, navigation, list presentation, editor interaction, autosave, archive UI)

## 12. Implementation references

- Model: `apps/api/personal_notes/models.py` (`PersonalNote`).
- Canonical service/query layer: `apps/api/personal_notes/services.py`
  (create, get, list active / archived, search active,
  update title/content, pin/unpin, archive, restore — all
  owner-scoped).
- HTTP layer: `apps/api/personal_notes/views.py` +
  `apps/api/personal_notes/serializers.py` (routes in
  `apps/api/config/urls.py`) — the thin authenticated boundary
  described in §10: it authenticates, validates the transport
  shape, and delegates every ownership resolution and mutation to
  the canonical service layer.
- Tests: `apps/api/personal_notes/tests.py` (domain) and
  `apps/api/personal_notes/tests_api.py` (HTTP lifecycle,
  privacy, CSRF, and representation contract).
- Frontend client (frontend-only, NO Notes UI):
  `apps/web/src/api/personal-notes.ts` — typed client on the
  `apiGet` / `apiPost` / `apiPatch` convention covering the complete
  §10 contract (canonical `ApiPersonalNote` DTO, title/content-only
  create/update inputs, the full read/write/action surface, trimmed
  + URL-encoded `?q=` search); pinned by
  `apps/web/src/api/personal-notes.test.ts`.
- Checkpoint: `docs/CURRENT_STATE.md` (§Personal Notes).
