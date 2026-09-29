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

There is no Trash / permanent-delete lifecycle in V1 (see §10).

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

## 10. Persisted fields in this slice

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
- Search
- HTTP API, serializers, and any UI

## 11. Implementation references

- Model: `apps/api/personal_notes/models.py` (`PersonalNote`).
- Canonical service/query layer: `apps/api/personal_notes/services.py`
  (create, get, list active / archived, update title/content,
  pin/unpin, archive, restore — all owner-scoped).
- Tests: `apps/api/personal_notes/tests.py`.
- Checkpoint: `docs/CURRENT_STATE.md` (§Personal Notes).
