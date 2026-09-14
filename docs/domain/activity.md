# FG Workspace — Activity Domain

This document is the canonical domain reference for **Activity**: the
durable awareness/history stream of the workspace.

Companion documents:

- `docs/domain/foundation.md` — Work Item, definitions, and Board semantics
  (the objects the first Activity slice covers).
- `docs/domain/authorization.md` — scopes and capabilities Activity reads
  must obey.
- `docs/CURRENT_STATE.md` — implementation checkpoint.

The invariants below are **settled decisions**. Code that contradicts this
document is an implementation defect.

## 1. Purpose and dominant invariant

Activity is an **awareness/history stream**, not a notification inbox.

An Activity entry answers, for a past action:

- **WHO** acted (actor user),
- **WHAT** happened (action/event kind + structured change semantics),
- **WHICH OBJECT** was affected (object type + identity),
- **WHERE** it happened (owning/access-control scope: Project / Research
  Group),
- **WHEN** it happened (occurrence timestamp).

Activity does not create obligations, drives no notifications, and changes
no state when read. It exists so users can see what happened around the
work they care about (future Home Activity rail) and so the Work Item
history remains durable.

## 2. Canonical persisted concept

Activity events are persisted as **`audit_history.AuditEvent`**
(append-only; no update or delete path exists, admin is read-only).

Events are recorded through **`audit_history.services.record_audit_event`**
called from inside the calling domain operation's `transaction.atomic()`
block. Do not build a parallel event/audit/history mechanism for any
domain; all workspace domain events use this one concept.

Every persisted event carries, directly or through stable references,
enough information to reconstruct the five questions above:

| Question | Persisted as |
|---|---|
| WHO | `actor` FK → User (`RESTRICT`; historical identities stay addressable) |
| WHAT | `event_type` (stable machine code, ≤ 80 chars) + `data` (structured, ID-based) |
| WHICH | affected-object FK (Work Item slice: `work_item` FK, `SET_NULL` so history survives an allowed hard delete) |
| WHERE | `research_group` FK (always) + `project` FK (Project-scoped objects) — the access-control scope |
| WHEN | `created_at` (occurrence timestamp, set on insert) |

`record_audit_event` validates scope consistency: the referenced Project and
Work Item must belong to the event's Research Group, and a Work Item to the
event's Project.

## 3. Structured semantics (no rendered strings as source of truth)

- `event_type` is a **stable machine code** (e.g. `work_item.created`),
  never a rendered English sentence. Presentation belongs to the read/UI
  layer.
- `data` stores **structured semantics**: stable IDs, fixed semantic enums,
  and from/to values. Human-readable names may be denormalized next to an
  ID as a display convenience, but the **ID is the source of truth**; a
  projection must never parse rendered strings.
- The Work Item status summary in `data["changes"]["statusDefinition"]`
  stores `{"id", "name", "category"}`, where `category` is the fixed
  semantic category (`todo` / `in_progress` / `review` / `done`). This makes
  a **completion** distinguishable from an ordinary status change from the
  persisted event alone — no join back to the (mutable, renameable)
  StatusDefinition is required.

## 4. Work Item event set (first slice)

Emission granularity is deliberately **one event per logical operation
(domain-level action boundary), not one event per changed column**. A single
atomic Work Item update that touches several fields produces exactly one
event whose structured `data` carries every related change, so a later
Activity projection can summarize the related changes sensibly.

| Domain action | Persisted as |
|---|---|
| Work Item created | `work_item.created` (`data = {}`) |
| Work Item updated (any combination of the tracked fields below, in one atomic update) | `work_item.updated` (`data = {"changes": {...}}`) |

Tracked change semantics inside `data["changes"]` (keys present only when
that aspect actually changed):

| Change | Stored as |
|---|---|
| Status changed | `statusDefinition: {"from": {"id","name","category"}, "to": {...}}` |
| **Completed** (status transition INTO the `done` category; drives server-managed `completed_at`) | same as above, with `to.category == "done"` — semantically distinct, no separate event kind |
| Transition away from `done` | ordinary status change (`from.category == "done"`); `completed_at` is cleared by the server |
| Assignee changed | `assignees: {"added": [<user ref>...], "removed": [<user ref>...]}` (user ref = `{"id","username","firstName","lastName"}`) |
| Due date changed (set, moved, **or cleared**) | `dueDate: {"from": "YYYY-MM-DD"\|null, "to": "YYYY-MM-DD"\|null}` |
| Title changed | `title: {"from", "to"}` |
| Description changed | `description: {"changed": true}` (bodies are never stored) |
| Type changed | `typeDefinition: {"from": {"id","name"}\|null, "to": ...}` |
| Blocked state/reason changed | `blockedReason: {"from", "to"}` (`null`/empty == unblocked) |
| Parent changed | `parent: {"from": {"id","title"}\|null, "to": ...}` |

Board drag-and-drop (`reposition_work_item`) uses the same contract: a
cross-column move records one `work_item.updated` event (its visible change
is the status transition); a pure within-column reorder records none
(position is an ordering implementation detail, not a domain change).

A **no-op update** (unchanged values, or only non-audited fields such as
`completed_at`/`updated_at`) records **no event** — history must not contain
fake changes.

Work Item comments are human discussion, not Activity, and are never
recorded as events.

## 5. Authorization (binding for every future Activity read)

**Activity obeys exactly the same authorization boundaries as the
underlying object. It must never become a privacy bypass.**

- A user may see an Activity entry about an object **iff the user can read
  that object today** through the canonical authorization path
  (see `docs/domain/authorization.md`).
- The scope FKs on the event (`project`, `research_group`) exist precisely
  so a future Activity feed can be **permission-filtered at the service
  layer**: forbidden objects must not leak through the collection, and
  Research Group admin status alone never grants visibility into a private
  Project's Activity.
- Proven in this slice: `GET /api/work-items/{id}/history/` enforces the
  **identical** read rule as the Work Item itself (ProjectMembership
  owner/member/viewer + current ResearchGroupMembership); a group admin
  without Project membership gets a non-leaking 404.

## 6. Transactional guarantee

An Activity event **participates in the same logical transaction** as the
domain mutation that produces it:

- the event is committed only if the mutation is committed;
- if the mutation rolls back, the event rolls back with it (no orphaned
  history);
- conversely, a committed mutation always has its event.

This is pinned by tests, including simulated post-mutation failures inside
an outer transaction for both create and update.

## 7. Scope of this slice / non-goals

Implemented and proven in this slice:

- the canonical persisted Activity event concept (reused, not recreated):
  `audit_history.AuditEvent` + `record_audit_event`;
- Work Item events: created, status changed, completed (distinct),
  assignee changed, due date changed;
- the authorization rule above for Work Item history;
- the transactional guarantee;
- `docs` + tests (`apps/api/work_items/tests_activity_foundation.py`,
  `apps/api/work_items/tests_history.py`, `apps/api/audit_history/tests.py`).

Explicitly **not** in this slice:

- no Activity API and no Home Activity rail / feed rendering yet — the
  persistence and domain foundation exists so a later projection can
  summarize the events;
- Activity is not a notification system (no push, no unread state, no
  inbox semantics);
- no events for other object kinds yet (Meeting, Project, etc. will reuse
  the same concept; any model/contract extension is follow-up work);
- no Work Item **deletion** event (existing behavior: an allowed hard
  delete keeps earlier events with `work_item` nulled).
