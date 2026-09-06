# FG Workspace — Current Implementation State

**Checkpoint:** Meetings + persistent Meeting Notes + Note → Work Item traceability + Meeting Templates + configurable Project Work Items + Board ordering
**Last verified:** 2026-09-03
**Branch:** `feature/meeting-next`

This document answers one question: *what is actually implemented in the
repository right now?* It is a checkpoint, not a roadmap. The durable domain
semantics live in `docs/domain/foundation.md` and `docs/domain/meetings.md`;
product intent lives in `docs/product.md`.

Markers:

- **IMPLEMENTED** — built and covered by backend tests and/or frontend wiring.
- **PARTIAL** — present but incomplete or with known gaps.
- **NOT IMPLEMENTED** — documented as direction but not in the code.
- **KNOWN ISSUE** — confirmed unresolved problem.

---

## Research Groups

- **IMPLEMENTED** — `ResearchGroup` and `ResearchGroupMembership` (roles `admin`, `member`).
- **IMPLEMENTED** — group membership does not imply Project access.
- **IMPLEMENTED** — group management: member list, member candidates, add/update roles, offboarding.
- **IMPLEMENTED** — personal cross-group scope and Research Group scope UI.
- **IMPLEMENTED** — Research Group Meetings are listed/created under a group.

## Projects

- **IMPLEMENTED** — private `Project` inside exactly one Research Group; `ProjectMembership` (`owner`/`member`/`viewer`).
- **IMPLEMENTED** — Project creator becomes `owner`; every active Project keeps at least one `owner`.
- **IMPLEMENTED** — Project lifecycle: archive / restore (archived Projects are read-only).
- **IMPLEMENTED** — membership management (list, add, change role, remove) with server-side authorization.
- **IMPLEMENTED** — Project overview work projections (milestones, attention) derived from canonical Work Items.
- **IMPLEMENTED** — Project List and Project Detail wired to the backend (no frontend demo data).

## Work Items

- **IMPLEMENTED** — single canonical `WorkItem` model; every Work Item belongs to exactly one Project.
- **IMPLEMENTED** — configurable Project definitions: `WorkItemTypeDefinition`, `WorkItemStatusDefinition` (fixed semantic category: `todo`/`in_progress`/`review`/`done`), `WorkItemLabelDefinition`.
- **IMPLEMENTED** — Work Items reference definitions by ID; the API contract uses `typeDefinitionId`, `statusDefinitionId`, `labelDefinitionIds`.
- **IMPLEMENTED** — default definitions created with a new Project; default-status invariant (exactly one active default, category `todo`).
- **IMPLEMENTED** — multiple assignees; an assignee must be a Project `owner` or `member` (a `viewer` cannot be assigned).
- **IMPLEMENTED** — Work Item hierarchy (parent/child, same Project, acyclic).
- **IMPLEMENTED** — `blockedReason`-derived blocked state; server-managed `completed_at` from status category.
- **IMPLEMENTED** — Work Item comments and history/activity feed.
- **IMPLEMENTED** — Project Board and Project List are views over the same canonical Work Items (no separate state).
- **IMPLEMENTED** — persisted manual Board ordering via `board_position` (nullable).
- **IMPLEMENTED** — Work Item deletion: `DELETE /api/work-items/{id}/` (server-side owner/member write authorization) permanently removes one Work Item and its Work-Item-owned dependents; children survive parent deletion as unparented (`parent` is `SET_NULL`); Meeting origin links are removed without touching the Meeting. The delete action is reachable from the Work Item drawer, Board card, and List row via a shared three-dot actions menu + confirmation dialog.
- **IMPLEMENTED** — Board drag and drop: cross-column drag atomically updates status and position (`reposition_work_item`), with an explicit insertion anchor (`beforeWorkItemId`).
- **IMPLEMENTED** — Board ↔ Editor status synchronization (Board column, Editor status, `statusDefinitionId`, and persisted state agree).

## Meetings

- **IMPLEMENTED** — Meeting scopes: **Research Group Meeting** (`group`, no Project) and **Project Meeting** (`project`, required Project), enforced by a DB check constraint.
- **IMPLEMENTED** — occurrence structure `Meeting → MeetingSection[] → MeetingItem[]`.
- **IMPLEMENTED** — standalone Meetings get a real default `Agenda` Section.
- **IMPLEMENTED** — MeetingItems belong to exactly one MeetingSection (NOT NULL).
- **IMPLEMENTED** — lifecycle `upcoming → live → completed` with explicit Start / End / Reopen actions; `started_at` / `ended_at` set by the server.
- **IMPLEMENTED** — canonical Live Meeting current pointer + item outcomes: `Meeting.current_meeting_item` (persisted `currentMeetingItemId`; OneToOne, `SET_NULL` when the item is deleted; may reference an item of any outcome) and `MeetingItem.outcome` (`not_discussed` / `done` / `follow_up` — `discussing` is NOT an outcome, legacy only). Changing current never mutates an outcome, and resolving an outcome never implicitly changes current except via the advance rule. Explicit actions `POST /api/meeting-items/{id}/focus|done|follow-up` (Live-only): Focus accepts any outcome and changes only the current pointer; Done/Follow-up are explicit outcome mutations that do not require the target to be current, and when the resolved item IS current they advance to the next `not_discussed` item after it in `Section.position`, `MeetingItem.position` order (wrapping once to the beginning; `null` when none remain). Start sets current to the first `not_discussed` item only if no valid current exists and never mutates outcomes; End is never blocked by the current pointer, allows remaining `not_discussed` items, clears `currentMeetingItemId`, and never mutates outcomes; Reopen sets current to the first remaining `not_discussed` only if current is null. Newly created (incl. spontaneous) items are `not_discussed` and never automatically current. Generic MeetingItem PATCH rejects both `outcome` and legacy `status`. Legacy data migrations (historical background): 0009/0010 mapped `open -> not_discussed`, `discussed -> done`; 0011 removed the `status` column, added `outcome` + the persisted current pointer, and mapped legacy `discussing` rows to the Meeting's current item + `not_discussed`.
- **IMPLEMENTED** — Live Meeting Selected-vs-Current UI: in a Live Meeting the agenda rail's *Selected* item (the item the user is viewing) is decoupled from the persisted *Current* item. Every agenda row is selectable regardless of outcome; clicking a row only changes the local (never-persisted) selection and the detail pane renders the selected item's content; the rail independently marks the actual current item ("Current" badge) and the selected non-current item ("Selected" badge); "Return to current" re-points the selection only. Selecting never moves the current pointer, never mutates an outcome, and calls no domain API. When current advances through Start/Done/Follow-up/Reopen, a following selection moves with it, while an explicit selection is preserved unless the selected item disappears. Done/Follow-up render only while the viewed item IS the current item. There is NO per-row Focus / make-current affordance in the Live rail; a deliberate "Make current" action is implemented in the selected-item detail context: while viewing a non-current item, the user can explicitly make that item the Meeting's persisted current item via the existing canonical Focus API (`POST /api/meeting-items/{id}/focus`, which accepts any outcome and changes only the current pointer); after success the local selection and the persisted current pointer converge; the agenda row itself remains selection-only; the Focus API remains implemented and unchanged.
- **IMPLEMENTED** — Meeting participants (relational, scope-authorized); creator auto-added.
- **IMPLEMENTED** — Meeting deletion: `DELETE /api/meetings/{id}/` permanently removes one occurrence and its Meeting-owned Sections, Items, Participants, and Work Item origin links. Server-side scoped write authorization (group admin / project owner+member, archived read-only). Canonical Work Items, Meeting Templates, and sibling occurrences are never deleted.
- **IMPLEMENTED** — occurrence Section editing: add / rename / edit / hide / reorder (one-off Sections never touch the Template).
- **IMPLEMENTED** — permission-filtered Meeting lists; group Meetings do not expose private Project data.
- **IMPLEMENTED** — persistent `MeetingNote` owned by exactly one `MeetingItem`: canonical author from the authenticated request (not client-spoofable), non-empty content, deterministic ordering, CASCADE on MeetingItem/Meeting deletion. Add/Edit/Delete reuse the Meeting write model and are Live-only (Upcoming and Completed reject authoring); Completed Notes are read-only protocol that survive reload. Notes are embedded in the Meeting items list (no N+1). Meeting Note != Work Item (no Project/status/assignment).
- **IMPLEMENTED** — canonical Note → Work Item: the composer's `Create work item` persists the Note first and opens the Work Item dialog anchored to that exact persisted Note (never open simultaneously; failure keeps the draft). One primary WorkItem per Note, enforced by a unique constraint on `MeetingItemWorkItem.meeting_note` plus a transactional pre-check. Group Meetings require an explicit Project choice (no silent preselect); Project Meetings preselect their writable Project. Definition IDs are validated server-side against the selected Project. Deletion is safe both ways (Note/WorkItem/MeetingItem/Meeting deletion keeps the other side; only the link row disappears).
- **IMPLEMENTED** — Linked work is rendered directly at the source Note (title, Project, assignees, status, permission-filtered) and opens the existing Work Item Inspector in place (Meeting context preserved); the Inspector shows `Created from` (Meeting, agenda item, source Note) resolved from the source relation. Unlinked Notes of Completed Meetings keep a quiet `Create work item` when the user can write the Meeting's scope.

## Meeting Templates

- **IMPLEMENTED** — Meeting Templates (persisted internally as `MeetingSeries`) with group or Project scope.
- **IMPLEMENTED** — editable Template Sections (name, description, order, active/inactive).
- **IMPLEMENTED** — creating a Meeting from a Template snapshots only **active** Template Sections into the occurrence.
- **IMPLEMENTED** — occurrence structure is independent from the Template after creation (Template edits never mutate an occurrence).
- **IMPLEMENTED** — only Templates matching the chosen Meeting scope are selectable.

## Meeting → Work Item

- **IMPLEMENTED** — a Work Item created from a MeetingItem is canonical Project work, linked via `MeetingItemWorkItem`.
- **IMPLEMENTED** — target Project is required; Work Item definitions come from that Project; a Project Meeting can only create work in its own Project.
- **IMPLEMENTED** — a Work Item created from a MeetingNote records the exact source Note on the same `MeetingItemWorkItem` link (Meeting → MeetingItem → MeetingNote → WorkItem); `meetingOrigin` is exposed on Work Item APIs and `linkedWorkItem` on Note APIs, each permission-filtered.

## My Work

- **IMPLEMENTED** — My Work is an authorized projection over assigned Work Items (personal cross-group and per-Research Group endpoints), wired to the frontend.

## Authorization / multi-user

- **IMPLEMENTED** — session authentication (login/logout/me, CSRF) with server-side, deny-by-default authorization.
- **IMPLEMENTED** — list endpoints are permission-filtered; forbidden objects do not leak through collections.
- **IMPLEMENTED** — Project scope enforcement for Project Meetings (read and write), including archived read-only behavior.
- **IMPLEMENTED** — audit history foundation for Work Item change tracking.

## Meeting concepts that are documented direction, NOT implemented

These appear in `docs/domain/meetings.md` as intended product direction but are **NOT IMPLEMENTED** in the current code:

- `Topic` (durable cross-Meeting discussion subject).
- `MeetingItem` `intent` (`inform`/`discuss`/`decide`), `origin` (`planned`/`spontaneous`), `decision_markdown`. (The persisted current pointer + `not_discussed`/`done`/`follow_up` outcomes ARE implemented; see above.)
- The richer `NoteEntry` Markdown entry stream (rich editor) and `inform` acknowledgements. Basic persistent Meeting Notes (attribution, add/edit/delete) ARE implemented; see `docs/domain/meetings.md` §32a.
- Durable follow-up carry-forward (the `follow_up` status exists; carry-forward as an action is not implemented) and the richer live-meeting ceremony (moderator and moderator rotation, per-item `intent`/`origin`). The Agenda | Current Item split UI IS implemented, the frontend-only **Selected** agenda-rail navigation (free browsing of any agenda item in a Live Meeting, decoupled from the persisted current item, with a "Return to current" action) is implemented frontend-only and not persisted, and the deliberate "Make current" action for a selected non-current item (canonical Focus, detail-pane only) IS implemented.
- Moderator and moderator rotation.
- Template default participants.
- A separate Work Item **discussion** link (distinct from the origin link).
- Protocol, Decision Log, and next-Meeting continuity projections.

## Not-yet-built product areas (placeholders, demo data)

- **PARTIAL / PLACEHOLDER** — Dashboard (`apps/web/src/features/dashboard`) uses hardcoded demo values; it is not a projection over canonical data.
- **NOT IMPLEMENTED** — Goals, Knowledge, KVP, and Tasks features (empty feature directories).

## Known technical debt / follow-ups

- **KNOWN ISSUE / TEST DEBT** — `e2e/project-work-item-inspector.spec.ts` is marked as a *temporary* validation test ("Not part of the permanent suite — safe to delete after review") and is not part of the permanent Playwright suite. It has been associated with flaky/known-failing E2E runs; treat it as test debt rather than a permanent regression signal until it is either stabilized or removed.
- **KNOWN ISSUE** — `MeetingItem.meeting_section` is NOT NULL and was backfilled for legacy flat items (meetings migrations 0005/0006); see `docs/domain/meetings.md` for the migration invariant.
