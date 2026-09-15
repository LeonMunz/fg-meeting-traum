# FG Workspace — Activity Domain

This document is the canonical domain reference for **Activity**: the
durable awareness/history stream of the workspace.

Companion documents:

- `docs/domain/foundation.md` — Work Item, definitions, and Board semantics
  (the objects the Work Item Activity slice covers).
- `docs/domain/meetings.md` — Meeting occurrences, agenda, lifecycle, and
  follow-up scheduling (the objects the Meeting Activity slice covers).
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
| WHICH | affected-object FK: `work_item` FK (Work Item events), `meeting` FK (Meeting events), or `project` FK (Project audit events, §4b) — all `SET_NULL` so history survives an allowed hard delete |
| WHERE | `research_group` FK (always) + `project` FK (Project-scoped objects) — the access-control scope |
| WHEN | `created_at` (occurrence timestamp, set on insert) |

The nullable `subject_user` FK is set only by the pre-existing
Project/Research Group audit events (§4b): it names the user the
operation acted upon. Work Item and Meeting events never set it, and it is
a historical record field, never an authorization input.

`record_audit_event` validates scope consistency: the referenced Project,
Work Item, and Meeting must belong to the event's Research Group, and a
Work Item / Project-scoped Meeting to the event's Project.

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

## 4a. Meeting event set (second slice)

The same emission granularity applies: **one event per logical
operation**, recorded transactionally through `record_audit_event`
inside the Meeting domain operation's `transaction.atomic()` block.

| Domain action | Persisted as |
|---|---|
| Meeting created (standalone or from a Series occurrence) | `meeting.created` (`data = {}`) |
| Meeting rescheduled (a real `scheduled_at` change, in one atomic update) | `meeting.rescheduled` (`data = {"changes": {"scheduledAt": {"from", "to"}}}`) |
| Meeting completed (live → completed via the End action) | `meeting.completed` (`data = {"changes": {"endedAt": ...}}`) |
| Agenda item added | `meeting.agenda_item_added` (`data = {"changes": {"agendaItem": {"id", "title"}}}`) |
| Follow-up scheduled to a Meeting | `meeting.follow_up_scheduled` (see below) |

Structured value rules for Meeting events:

- datetimes are stored as **UTC ISO-8601 strings** (`scheduledAt`,
  `endedAt`);
- the event's `meeting` FK is the affected Meeting; the event's
  `project` / `research_group` scope is that Meeting's own scope
  (`project` is null for group-scoped Meetings);
- a Meeting **title change is not a tracked aspect** in this slice: a
  title-only update (or one that re-sends the same `scheduled_at`)
  records **no event** — history must not contain fake changes;
- internal ordering/index writes (item `position` allocation, Series
  section snapshots, the default Agenda Section) never produce events;
- **`meeting.follow_up_scheduled`** is anchored to the **target**
  Meeting (the occurrence the follow-up was scheduled INTO):
  `event.meeting` = target Meeting, event scope = the target's
  Research Group / Project. Its structured payload:
  `data["sourceMeetingId"]` (a stable flat integer reference used by
  the feed's permission filter) plus
  `data["changes"]["followUp"]` carrying `sourceMeeting` /
  `sourceItem` / `targetSection` / `targetItem` refs
  (`{"id", "title"}`; the section ref is `{"id", "name"}`). The
  internally materialized target MeetingItem is an internal step of
  the scheduling operation and records **no separate**
  `meeting.agenda_item_added` event; an idempotent retry records no
  second event.

Deliberately **not** recorded in this slice (documented boundaries,
not omissions by accident): Meeting start / reopen, participant
add/remove, MeetingItem outcome transitions (done / follow-up /
reopen), Meeting deletion, MeetingSeries (template) mutations,
MeetingNotes.

## 4b. Project and Research Group audit events (pre-existing persistence, no feed projection yet)

The events below **predate** the aggregate Activity feed work. They are
already persisted as durable `AuditEvent`s through `record_audit_event`
inside the same transaction as the domain mutation, on the same canonical
concept. **None of them is currently returned by `GET /api/activity/`**:
persistence exists; Activity feed projection does not.

Project audit events (event `project` FK = the affected Project; `research_group` FK = the Project's group):

| Domain action | Persisted as | `subject_user` |
|---|---|---|
| Membership role change with assignment resolution | `project.member_assignments_resolved` | the affected member |
| Membership removal with assignment resolution | `project.member_assignments_resolved` | the removed member |
| Research Group offboarding, per-Project assignment resolution | `project.member_assignments_resolved` | the offboarded member |
| Research Group offboarding, final-owner ownership transfer | `project.ownership_resolved_for_offboarding` | the offboarded final owner |
| Project archived (manual archive; offboarding archive) | `project.archived` | not set |
| Project restored | `project.restored` | not set |
| Empty archived Project deleted | `project.deleted` | not set |

Notes: `project.member_assignments_resolved` stores the structured
resolution (`resolution`, `affectedWorkItemCount`, `replacementUserId`,
plus a `membershipAction` of `role_changed` / `removed` /
`offboarded`); `project.ownership_resolved_for_offboarding` stores the
transfer details (`replacementUserId`, `replacementPreviousRole`);
`project.archived` / `project.restored` store the resulting `status`;
`project.deleted` is recorded **before** the Project row is deleted (it
keeps a flat `projectId` / `projectName` snapshot, and its `project` FK is
nulled once the deletion commits), so it remains durable after the
Project no longer exists.

Research Group audit events (no `project` FK):

| Domain action | Persisted as | `subject_user` |
|---|---|---|
| Research Group member offboarded | `research_group.member_offboarded` | the offboarded member |

(`research_group.member_offboarded` stores the structured offboarding
summary: removed Project memberships, affected/transferred/unassigned
assignments, ownership transfers, archived Projects.)

`subject_user` semantics (narrow, as the code stands — not a general
event framework): the nullable `AuditEvent.subject_user` FK is set on
exactly these pre-existing Project/Research Group events, naming the user
the operation acted upon. Work Item and Meeting events never set it.
It is a historical record field; it is never an authorization input.

Future feed boundary: when a feed projection adds these events, the §5
rule applies at read time: an entry about a Project is visible only while
the requester can read that Project today through the canonical
authorization path (`docs/domain/authorization.md`), an entry about a
Research Group only while readable in the current group scope, and an
entry whose Project was hard-deleted (FK nulled) is not readable — never
a privacy bypass (a group admin without Project membership never sees a
private Project's audit events), never creation-time authorization.

## 5. Authorization (binding for every future Activity read)

**Activity obeys exactly the same authorization boundaries as the
underlying object. It must never become a privacy bypass.**

- A user may see an Activity entry about an object **iff the user can read
  that object today** through the canonical authorization path
  (see `docs/domain/authorization.md`). For Meetings this is the
  **creator-or-explicit-participant** rule (`MEETING_READ`): Research
  Group or Project membership, ownership, or admin status alone must
  NEVER grant Meeting Activity visibility. A
  `meeting.follow_up_scheduled` entry references BOTH Meetings, so it
  is visible only while the requester can read the source **and** the
  target Meeting today — target-only readability must not leak source
  Meeting metadata.
- The scope FKs on the event (`project`, `research_group`) exist precisely
  so a future Activity feed can be **permission-filtered at the service
  layer**: forbidden objects must not leak through the collection, and
  Research Group admin status alone never grants visibility into a private
  Project's Activity.
- Proven in this slice: `GET /api/work-items/{id}/history/` enforces the
  **identical** read rule as the Work Item itself (ProjectMembership
  owner/member/viewer + current ResearchGroupMembership); a group admin
  without Project membership gets a non-leaking 404.

The aggregate feed **`GET /api/activity/`** (Work Item slice events
and Meeting slice events) applies the **same** rule per event,
evaluated at read time on every request:

- a Work Item event is returned only if the requester can read the
  affected Work Item **today** — losing Project/Research Group
  membership immediately removes its historical events (read-time,
  not creation-time, authorization);
- a Meeting event is returned only if the requester can read the
  affected Meeting **today** (creator-or-participant); removing a
  participant immediately removes that Meeting's historical events;
- a `meeting.follow_up_scheduled` event is returned only if the
  requester can read BOTH the source and the target Meeting today;
- events whose Work Item or Meeting was hard-deleted (FK nulled) are
  not readable and never appear;
- the filter runs in the database **before** bounded pagination
  (`?limit=` 1..100, default 50; `?offset=` non-negative with a hard
  bound; invalid values → 400), so inaccessible events leak nothing:
  no title, actor, context, event data, existence, count, or
  ordering/page behavior. The response is a bare page — no total
  count is exposed;
- deterministic reverse-chronological order: newest `created_at`
  first, event `id` as the stable tie-breaker;
- structured projection only: event id / machine `eventType` /
  `createdAt`, the existing audit/history actor representation,
  affected Work Item id + current title **or** affected Meeting id +
  current title (the non-matching identity pair is null), Project and
  Research Group context (null Project for group-scoped Meetings), and
  the structured `changes` payload (for Work Items, `category` makes a
  completion distinguishable from an ordinary status change). No
  rendered sentences, no arbitrary `AuditEvent` internals.

Project and Research Group audit events (§4b) are persisted but
**not currently part of `GET /api/activity/`**; a future feed projection
that adds them must obey this same rule at read time — per-event,
evaluated on every request, never creation-time authorization.

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
- Meeting events: created, rescheduled, completed, agenda item added,
  follow-up scheduled (see §4a);
- the authorization rule above for Work Item history and Meeting
  Activity (including the dual-readability rule for follow-up
  schedules);
- the permission-safe aggregate read API `GET /api/activity/`
  (Work Item + Meeting slice events; see §5 for the binding read-time
  rule);
- the transactional guarantee;
- `docs` + tests (`apps/api/work_items/tests_activity_foundation.py`,
  `apps/api/work_items/tests_history.py`, `apps/api/meetings/tests_activity.py`,
  `apps/api/audit_history/tests.py`,
  `apps/api/audit_history/tests_activity_feed.py`,
  `apps/api/audit_history/tests_activity_feed_meetings.py`).

Explicitly **not** in this slice:

- no Home Activity rail / feed rendering yet — the read API exists so
  a later UI projection can summarize the events;
- Activity is not a notification system (no push, no unread state, no
  inbox semantics);
- no Activity feed projection for the pre-existing Project / Research
  Group audit events yet (§4b): they are persisted but not currently
  returned by `GET /api/activity/`, and no read-time authorization rules
  exist for those feed branches; later object kinds reuse the same
  concept, and any model/contract extension is follow-up work;
- no Work Item **deletion** event (existing behavior: an allowed hard
  delete keeps earlier events with `work_item` nulled).
