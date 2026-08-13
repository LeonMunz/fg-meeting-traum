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
- Meeting ↔ User → MeetingParticipant
- WorkItem ↔ MeetingItem discussion → WorkItemDiscussion

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

- Epic / Milestone / Deliverable / Task
- mandatory Project
- status
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

## Realtime

Realtime is not part of the Foundation.

Normal HTTP requests plus refresh/refetch are sufficient until a validated flow requires realtime behavior.

Do not add WebSockets merely because the application is multiuser.

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
