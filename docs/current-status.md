# FG Workspace — Current Status

**Last verified:** 2026-08-17  
**Audited branch:** `ui/projects-visual-pass`  
**Committed baseline:** `ab3c4ff`  
**Remote main at audit:** `ab3c4ff`

This document records the actual implementation state of the repository.

It is intentionally different from the product/domain documentation:

- `docs/product.md` describes product intent.
- `docs/domain/*.md` describe target domain semantics.
- `docs/architecture.md` describes the target architecture.
- **This file describes what is actually implemented right now.**

---

## 1. Executive Summary

The backend Foundation is already substantial and well tested.

Implemented server-side:

- session authentication
- Research Groups
- Research Group memberships
- private Projects
- Project memberships and roles
- Project authorization
- canonical Work Items
- multiple Work Item assignees
- Work Item hierarchy
- blocked reason semantics
- completion semantics
- My Work projection
- development seed data

The largest current MVP gap is the frontend/backend connection.

The Projects UI currently looks and behaves like a product prototype, but most Project and Work Item state is still generated from frontend demo data and React state rather than persisted through the existing backend APIs.

There is also one important architecture mismatch that must be resolved before treating the Foundation contract as stable:

> The current documentation defines Project-scoped WorkItem TypeDefinitions, StatusDefinitions, and LabelDefinitions, but the audited `main` implementation still stores WorkItem `type` and `status` as fixed enums.

A separate branch exists:

`feat/project-work-item-configuration`

but it is not part of the audited committed baseline.

---

## 2. Technical Health

Verified on 2026-08-17.

### Frontend

- Build: PASS
- Lint: PASS
- oxlint warnings: 0
- oxlint errors: 0
- Vite production build: PASS

Current stack:

- React 19
- React Router 8
- TypeScript 6
- Vite 8
- Tailwind CSS 4
- oxlint

There is currently no automated frontend test suite configured.

### Backend

- Django system check: PASS
- `makemigrations --check`: PASS
- Pending migrations: none
- Backend tests: **290 / 290 PASS**

Current stack:

- Python >= 3.12
- Django 5.2
- Django REST Framework
- PostgreSQL
- psycopg
- uv

---

## 3. Current Git State

At the time of the audit:

```text
ui/projects-visual-pass @ ab3c4ff
main                    @ ab3c4ff
origin/main             @ ab3c4ff
```

The current frontend branch has uncommitted local work:

```text
README.md
apps/web/src/features/projects/ProjectDetailPage.tsx
apps/web/src/features/projects/ProjectListPage.tsx
apps/web/vite.config.ts
```

Interpretation:

- `README.md` contains local development documentation work.
- `ProjectDetailPage.tsx` contains the current Project visual/layout pass.
- `ProjectListPage.tsx` contains the current Project layout pass.
- `vite.config.ts` contains a local development proxy/origin adjustment and must not be confused with product functionality.

A separate backend branch exists:

```text
feat/project-work-item-configuration @ 9a17326
```

It is **not included in this current-status assessment**.

---

## 4. Authentication

### Backend

Status: **IMPLEMENTED**

Available endpoints:

```text
GET  /api/auth/csrf/
POST /api/auth/login/
POST /api/auth/logout/
GET  /api/auth/me/
```

Properties already covered by tests:

- session authentication
- CSRF enforcement
- successful login
- invalid credentials
- session creation
- logout
- authenticated user lookup
- anonymous access rejection
- no client-side identity spoofing

### Frontend

Status: **IMPLEMENTED AND CONNECTED**

Implemented:

- Login page
- SessionProvider
- session recovery through `/api/auth/me/`
- logout
- protected routes
- CSRF-aware API client

Authentication is currently one of the few complete frontend-to-backend flows.

---

## 5. Research Groups

### Backend domain

Status: **IMPLEMENTED**

Models:

```text
ResearchGroup
ResearchGroupMembership
```

Roles:

```text
admin
member
```

Important rule:

> Research Group membership does not grant access to every Project.

### Backend API

Status: **IMPLEMENTED FOR CURRENT NEEDS**

Available:

```text
GET /api/research-groups/
GET /api/research-groups/{id}/
GET /api/research-groups/{id}/members/
```

Tests cover:

- authenticated list
- own groups only
- group detail authorization
- unrelated user denial
- membership isolation
- member lookup

### Frontend

Status: **PARTIALLY CONNECTED**

Real API client exists for:

```text
listResearchGroups()
getResearchGroup()
```

Research Group UI/components exist.

Research Group support is further along than Project persistence, but the full product-level group workspace is not yet the current MVP focus.

---

## 6. Projects

### Backend domain

Status: **IMPLEMENTED**

Model:

```text
Project
```

Fields currently implemented:

```text
id
name
description
status
research_group
created_at
updated_at
created_by
```

Statuses:

```text
active
paused
completed
```

Every Project belongs to exactly one Research Group.

### Project Membership

Status: **IMPLEMENTED**

Model:

```text
ProjectMembership
```

Roles:

```text
owner
member
viewer
```

Implemented invariants include:

- Project creator becomes owner.
- A Project member must belong to the Project's Research Group.
- Active Projects cannot lose their final owner.
- Research Group admins do not automatically bypass Project privacy.
- Users without ProjectMembership cannot access private Project content.
- Assigned Work Item users cannot be changed to an ineligible Project role while assignments still exist.

These rules are covered extensively by backend tests.

### Backend API

Status: **IMPLEMENTED**

Available endpoints:

```text
GET/POST  /api/research-groups/{group_id}/projects/
GET/PATCH /api/projects/{project_id}/

GET/POST  /api/projects/{project_id}/memberships/
PATCH/DELETE
          /api/projects/{project_id}/memberships/{membership_id}/

GET       /api/research-groups/{group_id}/members/
```

Backend tests cover:

- Project list
- Project privacy
- Project creation
- Project update
- owner/member/viewer access
- membership listing
- adding Project members
- role changes
- member removal
- final-owner protection
- Research Group membership prerequisite
- CSRF
- assignment lifecycle protection

### Frontend

Status: **UI IMPLEMENTED, API CONNECTION MISSING**

Existing UI:

- Project list
- Project creation dialog
- Project detail page
- Overview
- Work Items tab
- Members tab
- Settings tab
- project role/status display
- Project member dialogs
- loading/error/empty preview states
- polished Project layout

But the current Project UI still uses:

```text
initialProjects
demoProjects
demoDirectoryUsers
React useState
```

instead of the backend Project API.

Project creation currently updates local React state only.

Project settings currently update local React state only.

Project membership changes currently update local React state only.

Opening Project detail currently resolves demo Project IDs rather than fetching the real Project by backend ID.

### MVP gap

This is one of the highest-priority integration gaps.

---

## 7. Work Items

### Backend domain

Status: **IMPLEMENTED FOR THE CURRENT FIXED-ENUM MODEL**

Model:

```text
WorkItem
```

Current implemented fields:

```text
project
type
title
description
status
parent
due_date
blocked_reason
completed_at
created_at
updated_at
created_by
```

Current fixed types:

```text
epic
milestone
deliverable
task
```

Current fixed statuses:

```text
todo
in_progress
review
done
```

All Work Items belong to exactly one Project.

There are no projectless Work Items.

### Assignment

Status: **IMPLEMENTED**

Canonical relation:

```text
WorkItemAssignee
```

Properties:

- multiple assignees supported
- duplicate assignment prevented
- Project owner is assignable
- Project member is assignable
- viewer is not assignable
- non-member is not assignable
- stale memberships are rejected

### Hierarchy

Status: **IMPLEMENTED**

Supported:

```text
parent: WorkItem | null
```

Validated invariants:

- same Project
- no self-parent
- no cycles
- deeper cycles rejected
- parent may be changed
- parent may be cleared

There is deliberately no rigid type/parent matrix.

### Blocked semantics

Status: **IMPLEMENTED**

Canonical representation:

```text
blocked_reason
```

There is no canonical `is_blocked` field.

Blocked state is derived from whether `blocked_reason` contains content.

### Completion semantics

Status: **IMPLEMENTED**

Server manages:

```text
completed_at
```

Behavior covered by tests:

- moving to done sets `completed_at`
- reopening clears `completed_at`
- editing an already done item preserves completion timestamp
- client cannot directly set `completed_at`

### Backend API

Status: **IMPLEMENTED**

Available:

```text
GET/POST /api/projects/{project_id}/work-items/
GET/PATCH /api/work-items/{work_item_id}/
```

No Work Item DELETE contract is currently part of the audited Core API.

Backend tests cover:

- list
- detail
- creation
- update
- privacy
- write permissions
- multiple assignees
- hierarchy
- blocked reason
- completion
- spoofing protection
- CSRF
- stale membership protection
- transaction safety
- canonical consistency

### Frontend

Status: **UI IMPLEMENTED, API CONNECTION MISSING**

Existing UI:

- Project Work Items tab
- Board view
- List view
- canonical fixed types
- canonical fixed statuses
- multiple assignee display
- blocked reason semantics
- parent selection on creation
- due date
- Work Item filters
- Board/List preference persistence
- New Work Item dialog

But Work Items currently come from:

```text
demoWorkItems
React useState
```

Creation currently executes:

```text
setWorkItems(...)
```

instead of POSTing to the backend.

There is currently no frontend Work Item API module.

There is currently no persisted Work Item edit/detail flow connected to the backend.

### MVP gap

The UI must be connected to the existing backend API.

---

## 8. My Work

### Backend

Status: **IMPLEMENTED**

Endpoint:

```text
GET /api/research-groups/{group_id}/my-work/
```

My Work is correctly implemented as a projection over canonical Work Items.

It is not a second Work Item store.

Backend tests verify:

- assigned work appears
- unassigned work does not appear
- Project access is respected
- stale Project memberships are filtered
- stale Research Group memberships are filtered
- reassignment updates the projection
- the Work Item ID is identical between Project Work Items and My Work
- cross-group data does not leak

### Frontend

Status: **NOT IMPLEMENTED**

Current route:

```text
/my-work
```

renders a placeholder page.

### MVP gap

A real My Work page must consume the existing backend projection.

This is required for the Core acceptance flow.

---

## 9. Canonical Work Item Consistency

### Backend

Status: **IMPLEMENTED AND TESTED**

The backend already verifies that Project Work Items and My Work use the same canonical WorkItem row.

Tests cover consistency after:

- title changes
- status changes
- completion
- reopening
- blocked reason changes
- due date changes
- assignment
- unassignment
- reassignment

This is a strong part of the current implementation.

### Frontend

Status: **NOT YET PROVABLE END TO END**

Because Project Work Items are still frontend demo state and My Work is still a placeholder, the browser UI does not yet demonstrate this canonical consistency.

---

## 10. Project WorkItem Configuration

Status: **ARCHITECTURE / IMPLEMENTATION MISMATCH**

This is currently the most important contract decision before deeper frontend integration.

### Documentation currently specifies

Project-scoped:

```text
WorkItemTypeDefinition
WorkItemStatusDefinition
WorkItemLabelDefinition
```

The documentation says that:

- every Project receives default definitions
- owners may configure definitions
- WorkItems reference stable definition IDs
- visible status names may differ between Projects
- status semantic category remains canonical
- definitions remain Project-isolated
- labels use relational many-to-many semantics

### Audited backend implementation

The current `main` backend does **not** contain those models.

Instead `WorkItem` currently stores:

```text
type = fixed enum
status = fixed enum
```

The audited migrations contain only:

```text
work_items/migrations/0001_initial.py
```

for the Work Item app.

There is no committed TypeDefinition/StatusDefinition/LabelDefinition migration in the audited source.

### Separate work branch

A local/remote branch exists:

```text
feat/project-work-item-configuration
```

but it is not part of this audited current baseline.

### Required decision

Before making the frontend API integration contract permanent, choose one of two paths:

#### Option A — configuration is part of the MVP

Finish and merge the Project WorkItem Configuration backend migration first.

Then wire the frontend against the final definition-based API.

#### Option B — configuration is postponed

Explicitly freeze the MVP around the currently implemented fixed:

```text
epic / milestone / deliverable / task
todo / in_progress / review / done
```

and update the documentation/roadmap so the frontend is not built against a moving contract.

Do not continue indefinitely with documentation describing one canonical domain while production code implements another.

---

## 11. Development Seed / Living Lab

Status: **IMPLEMENTED**

Command:

```bash
uv run python manage.py seed_dev
```

Seed is idempotent.

Users:

```text
alex
chris
maria
laura
```

Default development password:

```text
DevPass1!
```

Research Group:

```text
FG Example
```

Example Projects:

```text
Paper XYZ
Maria Private Project
```

Example Project memberships:

```text
Paper XYZ:
  Alex  -> owner
  Chris -> member
  Laura -> viewer
  Maria -> no access

Maria Private Project:
  Maria -> owner
  Alex  -> no access
  Chris -> no access
  Laura -> no access
```

Example Work Items are also seeded for `Paper XYZ`.

This provides a good base for browser-level MVP acceptance testing once the frontend is API-connected.

---

## 12. Frontend API Layer

Status: **INCOMPLETE**

Currently implemented frontend API modules:

```text
auth.ts
client.ts
research-groups.ts
```

Current generic client supports:

```text
GET
POST
```

Missing primitives required by the already-existing backend:

```text
PATCH
DELETE
```

Missing frontend API modules include:

```text
projects.ts
project-memberships.ts
work-items.ts
my-work.ts
```

or an equivalent organization.

The frontend API response types currently only cover:

```text
ApiUser
ApiResearchGroup
```

Project, Membership, Work Item and My Work API contracts still need typed frontend representations.

---

## 13. Frontend Domain Types

Status: **PARTIALLY OUTDATED**

`apps/web/src/domain/types.ts` already contains conceptual:

```text
Project
WorkItem
Meeting
```

but these are not currently the actual API contract used by the Project UI.

Notable mismatches:

- frontend conceptual Project IDs are strings
- backend Project IDs are integer database IDs
- Project UI uses human-readable demo IDs
- Work Item UI has local `DemoWorkItem` types
- API types do not yet represent Project or WorkItem responses
- comments still refer to some already-implemented Foundation layers as "future"

These types should be cleaned up as part of real API integration rather than maintaining another parallel domain representation.

---

## 14. Meetings

### Domain documentation

Status: **DESIGNED**

Meeting domain documentation already defines concepts including:

- Meeting
- MeetingSeries
- MeetingParticipant
- Topic
- MeetingItem
- follow-up
- Meeting -> Work Item
- historical discussion relationships

### Backend

Status: **NOT IMPLEMENTED**

There is currently no Meeting Django app in the audited source.

### Frontend

Status: **NOT IMPLEMENTED**

`/meetings` currently renders a placeholder.

### Decision

Do not begin Meeting implementation until the Foundation Core browser flow works end to end.

---

## 15. Other Product Areas

The following routes currently render placeholders:

```text
/my-work
/goals
/meetings
/kvp
/knowledge
/calendar
/people
/notifications
/settings
/profile
```

These should not distract from the immediate MVP Foundation.

`/my-work` is the exception because it is part of the Core acceptance flow and should be implemented before Meetings.

---

## 16. End-to-End Capability Matrix

Legend:

- **READY** = implemented through the required stack
- **BACKEND** = backend exists, frontend missing/not connected
- **UI DEMO** = UI exists but is not persisted through canonical backend
- **PLACEHOLDER** = route/UI placeholder
- **MISMATCH** = current architecture contract is unresolved

| Capability | Domain | Backend API | Frontend UI | Persistent | Backend tested | Current state |
|---|---:|---:|---:|---:|---:|---|
| Login/session | yes | yes | yes | yes | yes | READY |
| Research Group list/detail | yes | yes | yes | yes | yes | READY/PARTIAL UI |
| Project privacy | yes | yes | demo UI | yes | yes | BACKEND |
| Project list | yes | yes | yes | no from UI | yes | UI DEMO |
| Create Project | yes | yes | yes | no from UI | yes | UI DEMO |
| Edit Project | yes | yes | yes | no from UI | yes | UI DEMO |
| Project member list | yes | yes | yes | no from UI | yes | UI DEMO |
| Add Project member | yes | yes | yes | no from UI | yes | UI DEMO |
| Change Project role | yes | yes | yes | no from UI | yes | UI DEMO |
| Remove Project member | yes | yes | yes | no from UI | yes | UI DEMO |
| Work Item list | yes | yes | yes | no from UI | yes | UI DEMO |
| Create Work Item | yes | yes | yes | no from UI | yes | UI DEMO |
| Edit Work Item | yes | yes | incomplete | no from UI | yes | BACKEND |
| Multiple assignees | yes | yes | yes | no from UI | yes | UI DEMO |
| Work Item hierarchy | yes | yes | create UI | no from UI | yes | UI DEMO |
| Blocked reason | yes | yes | yes | no from UI | yes | UI DEMO |
| Completion semantics | yes | yes | visual only | no from UI | yes | BACKEND |
| My Work | yes | yes | placeholder | yes backend | yes | BACKEND |
| Same item in Project/My Work | yes | yes | no | yes backend | yes | BACKEND |
| Project WorkItem configuration | documented | unresolved branch | removed/not active | unresolved | not on main | MISMATCH |
| Meetings | documented | no | placeholder | no | no | PLACEHOLDER |

---

## 17. Core Acceptance Flow

The documented Core checkpoint is approximately:

```text
Alex authenticates
→ opens Research Group
→ creates Project
→ becomes Project Owner
→ adds Chris
→ creates Work Item in Project
→ assigns Chris
→ Chris authenticates
→ Chris sees Work Item in My Work
→ Chris opens the same Work Item in Project
→ unauthorized user cannot access Project
```

### Backend

Status: **PASS**

A dedicated backend Core checkpoint integration test already covers this flow.

### Browser / frontend

Status: **FAIL / NOT YET CONNECTED**

The current Project UI uses demo state and My Work is a placeholder.

Therefore:

> The Foundation is backend-capable but not yet an end-to-end usable MVP.

---

## 18. Highest-Priority MVP Blockers

### P0 — Resolve WorkItem configuration contract

Decide whether Project-scoped Type/Status/Label definitions are:

1. part of the immediate MVP and must be merged before frontend integration, or
2. deliberately postponed until after the Core checkpoint.

The current documentation and current `main` implementation disagree.

### P0 — Connect Projects frontend to backend

Replace:

```text
initialProjects
demoProjects
local Project mutations
```

with real Project API calls.

### P0 — Connect Project memberships

Use existing membership APIs for:

- list
- add
- role change
- removal

### P0 — Connect Work Items frontend

Replace:

```text
demoWorkItems
setWorkItems-only creation
```

with canonical server Work Items.

### P0 — Implement My Work frontend

Consume:

```text
GET /api/research-groups/{group_id}/my-work/
```

This is required to prove the central product concept.

### P1 — Work Item detail/edit flow

Implement a real detail/edit interaction using:

```text
GET/PATCH /api/work-items/{id}/
```

Do not invent Work Item deletion unless the product/domain contract explicitly adds it.

### P1 — Browser acceptance test

Manually and later automatically verify:

```text
Alex creates Project
Alex adds Chris
Alex creates Work Item assigned to Chris
Chris sees it in My Work
Chris opens the same canonical Work Item
Maria cannot access private Project
```

---

## 19. Recommended Implementation Order

The fastest path toward a functioning MVP is:

### Step 1 — Contract freeze

Resolve Project WorkItem Configuration first.

Do not wire a large frontend against an API contract that is about to change.

### Step 2 — Frontend API foundation

Extend the API client with the required methods:

```text
GET
POST
PATCH
DELETE
```

Add typed API contracts for:

```text
Project
ProjectMembership
ResearchGroupMember
WorkItem
MyWork
```

### Step 3 — Real Project List

Replace demo Project list data with:

```text
GET /api/research-groups/{group_id}/projects/
```

Connect Project creation.

### Step 4 — Real Project Detail

Fetch:

```text
GET /api/projects/{project_id}/
GET /api/projects/{project_id}/memberships/
GET /api/projects/{project_id}/work-items/
```

Remove `demoProjects`, `demoDirectoryUsers`, and `demoWorkItems` as sources of product state.

### Step 5 — Real Project mutations

Connect:

```text
Project PATCH
member add
member role change
member removal
```

### Step 6 — Real Work Item mutations

Connect:

```text
Work Item POST
Work Item PATCH
assignees
parent
due date
blocked reason
status
```

### Step 7 — My Work

Implement `/my-work` using the already-existing backend projection.

### Step 8 — Core browser checkpoint

Run the complete multi-user flow with seed users.

### Step 9 — Only then expand scope

After the Core checkpoint is reliable, proceed toward Meetings.

Goals, KVP, Knowledge, Calendar and other product areas remain secondary until the Core workflow works.

---

## 20. Current Product Assessment

The project is not starting from zero.

The backend already contains a strong multi-user and authorization Foundation with substantial automated coverage.

The primary MVP risk is currently not missing backend CRUD.

The primary risks are:

1. frontend demo state masking existing backend capability,
2. an unresolved WorkItem configuration contract,
3. no frontend My Work implementation,
4. lack of a browser-level multi-user acceptance flow.

The shortest path to MVP is therefore:

```text
freeze canonical WorkItem contract
→ wire Projects to backend
→ wire Work Items to backend
→ implement My Work
→ prove the multi-user Core checkpoint
→ then build Meetings
```

---

## 21. Next Status Update

Update this document after any milestone that materially changes one of:

- canonical domain contract
- backend API surface
- frontend persistence
- Core acceptance flow
- test health
- MVP blocker list

Do not use this document as a replacement for canonical domain or architecture documentation.

Its purpose is to answer one question:

> What actually works in the repository today?
