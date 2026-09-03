# FG Workspace — Current Implementation State

**Checkpoint:** Meetings + persistent Meeting Notes + Meeting Templates + configurable Project Work Items + Board ordering
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
- **IMPLEMENTED** — Meeting participants (relational, scope-authorized); creator auto-added.
- **IMPLEMENTED** — Meeting deletion: `DELETE /api/meetings/{id}/` permanently removes one occurrence and its Meeting-owned Sections, Items, Participants, and Work Item origin links. Server-side scoped write authorization (group admin / project owner+member, archived read-only). Canonical Work Items, Meeting Templates, and sibling occurrences are never deleted.
- **IMPLEMENTED** — occurrence Section editing: add / rename / edit / hide / reorder (one-off Sections never touch the Template).
- **IMPLEMENTED** — permission-filtered Meeting lists; group Meetings do not expose private Project data.
- **IMPLEMENTED** — persistent `MeetingNote` owned by exactly one `MeetingItem`: canonical author from the authenticated request (not client-spoofable), non-empty content, deterministic ordering, CASCADE on MeetingItem/Meeting deletion. Add/Edit/Delete reuse the Meeting write model and are Live-only (Upcoming and Completed reject authoring); Completed Notes are read-only protocol that survive reload. Notes are embedded in the Meeting items list (no N+1). Meeting Note != Work Item (no Project/status/assignment).

## Meeting Templates

- **IMPLEMENTED** — Meeting Templates (persisted internally as `MeetingSeries`) with group or Project scope.
- **IMPLEMENTED** — editable Template Sections (name, description, order, active/inactive).
- **IMPLEMENTED** — creating a Meeting from a Template snapshots only **active** Template Sections into the occurrence.
- **IMPLEMENTED** — occurrence structure is independent from the Template after creation (Template edits never mutate an occurrence).
- **IMPLEMENTED** — only Templates matching the chosen Meeting scope are selectable.

## Meeting → Work Item

- **IMPLEMENTED** — a Work Item created from a MeetingItem is canonical Project work, linked via `MeetingItemWorkItem`.
- **IMPLEMENTED** — target Project is required; Work Item definitions come from that Project; a Project Meeting can only create work in its own Project.

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
- `MeetingItem` `intent` (`inform`/`discuss`/`decide`), `origin` (`planned`/`spontaneous`), `decision_markdown`, and the `not_discussed`/`discussing`/`done`/`follow_up` item states (implemented state is `open`/`discussed`).
- The richer `NoteEntry` Markdown entry stream (rich editor) and `inform` acknowledgements. Basic persistent Meeting Notes (attribution, add/edit/delete) ARE implemented; see `docs/domain/meetings.md` §32a.
- Follow-up / carry-forward and the richer live-meeting ceremony.
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
