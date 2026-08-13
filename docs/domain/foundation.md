# FG Workspace — Foundation Domain

This document is the canonical domain reference for the first product phase:

```text
Identity
→ Research Group
→ Project + ProjectMembership
→ WorkItem + WorkItemAssignee
→ My Work + Project Board
```

## 1. User identity and session context

The system requires a real server-verified user identity.

Conceptual UI/session context:

```ts
type SessionContext = {
  currentUserId: string
  activeResearchGroupId: string
}
```

`currentUserId` is derived from authenticated server state (`request.user`), not trusted from a browser-supplied field.

`activeResearchGroupId` may be selected by the UI, but the server must verify that the authenticated user has a valid membership.

The first Living Lab may use only one Research Group while the data model remains capable of multiple groups.

## 2. Research Group

A Research Group is the shared organizational context.

Conceptual model:

```text
ResearchGroup

id
name
created_at
updated_at
created_by_id
```

### ResearchGroupRole

```ts
type ResearchGroupRole =
  | 'admin'
  | 'member'
```

### ResearchGroupMembership

```text
ResearchGroupMembership

id
research_group_id
user_id
role
joined_at
```

Constraint:

```text
UNIQUE(research_group_id, user_id)
```

### Group role semantics

**member**
- sees group-level content
- may create Projects
- may be added to Projects
- may participate in group-level Meetings

**admin**
- additionally manages Research Group membership/settings

A Research Group admin does **not** automatically gain access to private Projects.

## 3. Project

A Project is a protected work space inside exactly one Research Group.

Conceptual model:

```text
Project

id
research_group_id
name
description
status
created_at
updated_at
created_by_id
```

Status:

```ts
type ProjectStatus =
  | 'active'
  | 'paused'
  | 'completed'
```

### Project creation

Every active Research Group member may create a Project.

Creation is atomic:

```text
create Project
  +
create ProjectMembership(role='owner') for creator
```

The creator becomes an Owner automatically.

## 4. Project Membership

Research Group membership does not imply Project access.

```ts
type ProjectRole =
  | 'owner'
  | 'member'
  | 'viewer'
```

Conceptual relational model:

```text
ProjectMembership

id
project_id
user_id
role
added_at
added_by_id
```

Constraint:

```text
UNIQUE(project_id, user_id)
```

Domain rule:

> A ProjectMembership user must have a valid ResearchGroupMembership in the Project's Research Group.

### Owner

May:
- read and edit Project
- manage memberships
- change roles
- create/edit Work Items
- assign Work Items
- change Project status

### Member

May:
- read Project
- create/edit Work Items
- assign Work Items to eligible Project users
- move Work Items through the workflow

### Viewer

May:
- read Project
- read Work Items

May not:
- create/edit Work Items
- be assigned a Work Item

### No ProjectMembership

The Project is not visible as a work space and its private data must not be returned by the API.

## 5. Project Owner invariant

Every active Project has at least one Owner.

The last Owner may not:
- remove themselves,
- be downgraded,
- be removed through group-membership cleanup

unless another Owner is established atomically.

Administrative removal from the Research Group must not leave an active Project ownerless.

The exact group-removal workflow can be implemented when group administration is built, but the invariant already applies.

## 6. Work Item

All actionable project work uses one shared WorkItem base entity.

### WorkItemType

```ts
type WorkItemType =
  | 'epic'
  | 'milestone'
  | 'deliverable'
  | 'task'
```

Semantics:

- **Epic** — large initiative/work area
- **Milestone** — important project checkpoint/target
- **Deliverable** — concrete result to deliver
- **Task** — concrete executable work

Types share the first common workflow and may gain type-specific rules only after validated need.

### WorkItemStatus

```ts
type WorkItemStatus =
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'done'
```

Initial board:

```text
To Do → In Progress → Review → Done
```

## 7. Work Item conceptual API model

```ts
type WorkItem = {
  id: string

  projectId: string
  type: WorkItemType

  title: string
  description?: string

  status: WorkItemStatus

  assigneeIds: string[]

  parentId?: string

  dueDate?: string

  blockedReason?: string

  completedAt?: string

  sourceMeetingItemId?: string

  createdAt: string
  updatedAt: string
  createdById: string
}
```

This API shape does not prescribe PostgreSQL storage.

## 8. Project is mandatory

Every Work Item belongs to exactly one Project.

```text
WorkItem.project_id NOT NULL
```

There are no projectless Tasks, Deliverables, Milestones, or Epics.

This rule also applies to Work Items created later from Meetings.

## 9. Work Item assignment

A Work Item can have one or more assignees.

An assignee must have a ProjectMembership on the Work Item's Project with role:

```text
owner
member
```

A `viewer` cannot be assigned.

A user without ProjectMembership cannot be assigned.

This must be validated server-side.

## 10. WorkItemAssignee relation

Do not store foreign-key arrays in PostgreSQL.

Use a relational join model:

```text
WorkItemAssignee

work_item_id
user_id
```

Constraint:

```text
UNIQUE(work_item_id, user_id)
```

The API may still expose `assigneeIds`.

## 11. Blocked semantics

`blocked` is not a workflow status.

Do not store both `isBlocked` and `blockedReason`.

Use:

```text
blockedReason NULL/empty
→ not blocked

blockedReason present
→ blocked
```

The UI may derive:

```ts
const isBlocked = Boolean(workItem.blockedReason)
```

## 12. Completion semantics

When status changes to:

```text
done
```

set:

```text
completed_at
```

When a completed Work Item is reopened, clear `completed_at`.

This transition behavior must be tested.

## 13. Work Item hierarchy

A Work Item may have an optional parent.

Examples:

```text
Epic
└── Deliverable
    ├── Task
    └── Task
```

The first version does not enforce a rigid parent type matrix.

Mandatory invariants:

1. Parent and child belong to the same Project.
2. A Work Item cannot be its own parent.
3. Cycles are forbidden.
4. Cross-Project hierarchy is forbidden.

## 14. My Work

My Work is not a separate task database.

It is an authorized projection over Work Items:

```text
WorkItem
WHERE current authenticated user is assignee
AND current user still has Project access
```

Possible UI filters:

- All
- Today
- Overdue
- Blocked
- Done

No `MyWorkTask` entity is created.

## 15. Project Board

The Project Board is another projection over the same Work Items.

Columns correspond to `WorkItem.status`.

Moving an item changes the canonical Work Item and is reflected everywhere else.

No `KanbanTask` entity exists.

## 16. Dashboard

Dashboard data is derived from canonical entities.

Examples:
- relevant assigned Work Items
- overdue Work Items
- blocked Work Items
- accessible active Projects
- later upcoming Meetings/follow-ups

Do not create dashboard-specific copies of domain entities.

## 17. Canonical relationships

Persist a relationship once unless a concrete optimization requires deliberate denormalization.

Examples:

- `WorkItem.project_id` is canonical; no persisted `Project.workItemIds`.
- `ProjectMembership(project_id, user_id)` is canonical for Project access.
- `WorkItemAssignee(work_item_id, user_id)` is canonical for assignment.

## 18. Authorization requirements

Authorization is deny-by-default and server-side.

Protected endpoints must check the authenticated user.

List endpoints must filter inaccessible Projects and Work Items rather than returning them for the frontend to hide.

A React visibility rule is not a security boundary.

## 19. Foundation invariants

These are the non-negotiable contract of the Core phase:

1. Authenticated identity is never established from a freely client-supplied `currentUserId`.
2. Every Project belongs to exactly one Research Group.
3. ResearchGroupMembership does not imply ProjectMembership.
4. Every ProjectMembership user belongs to the same Research Group as the Project.
5. Project creator becomes Owner.
6. Every active Project has at least one Owner.
7. Without ProjectMembership, a Project workspace and its private content are inaccessible.
8. Every Work Item belongs to exactly one Project.
9. No projectless Epic, Milestone, Deliverable, or Task exists.
10. Every Work Item assignee is a Project Owner or Member.
11. A Viewer cannot be an assignee.
12. Work Item parent/child relations stay inside one Project.
13. Work Item hierarchy is acyclic.
14. `blocked` is derived from `blockedReason`, not a workflow status.
15. `done` sets `completed_at`; reopening clears it.
16. My Work and Project Board reference the same Work Items.
17. API ID lists do not imply PostgreSQL foreign-key arrays.
18. Many-to-many relationships are relational.
19. Project authorization is enforced by the server.
20. Permission-filtered list endpoints do not leak private resources.

## 20. Core acceptance flow

The Foundation is complete only when this end-to-end scenario works:

```text
Alex logs in
→ creates Paper XYZ
→ becomes Owner
→ adds Chris as Member
→ creates "Rewrite Introduction" assigned to Chris

Chris logs in
→ sees Paper XYZ
→ sees "Rewrite Introduction" in My Work
→ sees the same Work Item in Paper XYZ

Maria logs in
→ cannot see Paper XYZ
```

Do not start the Meeting domain before this flow is reliable.
