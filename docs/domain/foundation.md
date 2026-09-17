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
  +
create default WorkItem configuration for the Project
```

The creator becomes an Owner automatically.

The Project receives a usable WorkItem configuration on creation
(see Section 3a).

## 3a. Project WorkItem Configuration

Each Project maintains its own WorkItem configuration.

Project A configuration is independent from Project B configuration.

Configuration includes:

- WorkItem TypeDefinitions
- WorkItem StatusDefinitions
- WorkItem LabelDefinitions

Configuration is:

- shared by all authorized Project users
- persisted server-side
- Project-scoped
- managed by Project owners

Configuration is NOT:

- a UI-only preference
- a ResearchGroup-global setting
- a generic workflow engine

### 3a.1. WorkItem TypeDefinitions

A WorkItemTypeDefinition identifies a kind of work item for a Project.

Conceptual fields:

```text
WorkItemTypeDefinition

id
project_id
name
kind
order
active
```

The stable identity is the definition ID. The display name is editable.
Therefore a Project owner may rename a Type without recreating existing
WorkItems.

**Semantic Kind.** `WorkItemTypeDefinition` display name is presentation
metadata. Canonical Work Item type semantics are represented by a stable
machine-readable kind and must never be inferred from the display name.

The kind is the stable, machine-readable semantic concept of the
definition:

```text
kind

task
epic
milestone
deliverable
```

- **Canonical kinds.** The four starter (default) TypeDefinitions carry
  their fixed canonical kind: `Epic → epic`, `Milestone → milestone`,
  `Deliverable → deliverable`, `Task → task`. A default definition may be
  renamed to any display name without changing its kind
  (`kind = task`, `name = "Experiment step"` is the same canonical Task
  type under a customized display name).
- **Custom / unclassified types.** Project-specific types created by
  owners (`Experiment`, `Manuscript Section`, `Figure`, `Dataset`, ...)
  carry **no canonical kind** (`null`). Their semantic meaning is never
  inferred from their names, and a custom type is never classified as one
  of the four canonical kinds.
- **Assignment and editability.** The kind is system-assigned only:
  the canonical default definitions receive it when the system creates
  them at Project creation — the system classifies the very rows it
  creates. There is deliberately NO data backfill: the legacy
  machine-readable type values lived on the Work Item (`type` choices)
  and were dropped by the definition migration without ever being
  stored on the definitions, so no machine-readable provenance
  identifies which pre-existing definitions were canonical. Legacy
  definitions without provable semantic provenance therefore have
  `kind = null` — false negatives are acceptable, false semantic
  attribution is not. The configuration API exposes the kind read-only;
  there is no API or UI path to set or change a definition's kind. The
  display name and `order`/`active` configuration remain owner-editable;
  the semantic kind of an existing canonical definition is not casually
  changed.
- **Name rule.** Display names are presentation metadata and are never
  an authoritative source for semantic kind, including during data
  migration. Classification by any combination of `name`, `order`,
  `active`, project age, or the "exact four-name set" is forbidden: an
  owner-created custom type named exactly `Task` would be
  misclassified, and a renamed canonical default would be lost.
- **Runtime rule.** All runtime resolution (My Work, projections,
  presentation) reads the stored `kind` field; it must never be derived
  from the display `name` at runtime.

**Default Types.** Every newly created Project receives starter
TypeDefinitions:

- Epic (kind `epic`)
- Milestone (kind `milestone`)
- Deliverable (kind `deliverable`)
- Task (kind `task`)

**Creating Types.** Project owners may create additional types (kind
`null`):

- Experiment
- Manuscript Section
- Figure
- Dataset

**Deactivating Types.** Referenced TypeDefinitions use deactivation
rather than destructive removal. An inactive TypeDefinition:

- remains readable
- remains attached to WorkItems that already reference it
- does not mutate existing WorkItems
- cannot normally be selected for a new WorkItem

No automatic reassignment occurs when a Type is deactivated.

**Types and Hierarchy.** WorkItem type does not govern hierarchy rules.
A Project may define custom Types without a workflow engine or parent
type matrix.

### 3a.2. WorkItem StatusDefinitions

A WorkItemStatusDefinition identifies a workflow status for a Project.

Conceptual fields:

```text
WorkItemStatusDefinition

id
project_id
name
category
order
active
is_default
```

The visible name is Project-configurable. The system semantic category
remains fixed.

**Allowed semantic categories:**

```text
todo
in_progress
review
done
```

Categories preserve cross-Project system behavior:

- Is this WorkItem broadly todo?
- Is it in progress?
- Is it under review?
- Is it completed?
- Should completed_at be populated?

Custom display name does not change system semantic meaning.

**Default Statuses.** Every newly created Project receives:

- "Todo" — category: todo — is_default: true
- "In Progress" — category: in_progress
- "Review" — category: review
- "Done" — category: done

Only "Todo" is initially the default status.

**Default Status Invariant.** Each Project must have exactly one active
default WorkItem status. The default status is used when a new WorkItem
is created without an explicit status. For Core simplicity, the default
status must belong to category `todo`.

**Status Category Safety.** Once a StatusDefinition is referenced by
any WorkItem, its category must not be changed. A Project owner may
still rename, reorder, or deactivate it. Changing the category on an
already-used status is forbidden because it could silently reinterpret
existing WorkItems and make completed_at inconsistent.

If a Project needs different semantics, the owner should:

1. Create a new StatusDefinition with the desired category.
2. Explicitly move WorkItems to the new StatusDefinition.
3. Optionally deactivate the old definition.

**Deactivating Statuses.** Referenced StatusDefinitions use
deactivation rather than destructive removal. An inactive StatusDefinition:

- remains readable
- remains attached to existing WorkItems
- cannot normally be selected as a new transition target
- does not automatically move WorkItems elsewhere

The Project must always retain exactly one active default status.
Deactivating the current default is forbidden until another valid
active default status (category `todo`) has been selected.

**Completion and Category.** When a WorkItem transitions to a
StatusDefinition whose category is `done`, the server sets
`completed_at`. When the WorkItem transitions from a `done` category
to a non-`done` category, the server clears `completed_at`. A
transition between two `done` statuses does not clear `completed_at`.

### 3a.3. WorkItem LabelDefinitions

A WorkItemLabelDefinition identifies a lightweight category for
WorkItems in a Project.

Conceptual fields:

```text
WorkItemLabelDefinition

id
project_id
name
order
active
```

A WorkItem may have zero or multiple labels.

The relationship is a relational many-to-many join.

**Creating Labels.** Project owners may create labels:

- Manuscript
- Dataset
- Reviewer Response
- Urgent

**Deactivating Labels.** Referenced Labels use deactivation rather
than destructive removal. An inactive Label:

- stays attached to existing WorkItems
- remains readable
- cannot normally be newly assigned
- does not disappear from historical or current WorkItems automatically

**Label Color.** Label color and other visual presentation metadata
are currently an unresolved product/UI decision.

### 3a.4. Same-Project Configuration Invariant

Canonical invariant:

```text
WorkItem.project
==
WorkItem.type_definition.project
==
WorkItem.status_definition.project
```

Every WorkItem label must also satisfy:

```text
label.project == WorkItem.project
```

Cross-Project configuration assignment is invalid.

Knowing a Definition ID must not bypass Project authorization.

### 3a.5. Project Configuration Permissions

**Project Owner** may:

- read WorkItem configuration
- create, rename, reorder, and deactivate TypeDefinitions
- create, rename, reorder, and deactivate StatusDefinitions
  (subject to default status and category safety invariants)
- select or change the default StatusDefinition (subject to invariants)
- create, rename, reorder, and deactivate LabelDefinitions

**Project Member** may:

- read configuration
- use active Types, Statuses, and Labels in WorkItem writes
- read inactive definitions when referenced by existing WorkItems

May NOT configure the Project workflow.

**Project Viewer** may:

- read Project configuration
- read WorkItems and their definitions/labels

May NOT configure workflow or mutate WorkItems.

**No ProjectMembership:**

No access to Project configuration.

**ResearchGroup Admin:**

Does NOT bypass Project privacy. Effective access still requires
both current ResearchGroupMembership and current ProjectMembership.

### 3a.6. Configuration vs. UI Preferences

**Project WorkItem Configuration** (Types, Statuses, Labels):

- shared by all Project users
- persisted server-side
- canonical domain state
- owner-managed
- Project-scoped

**UI Preferences** (board vs. list view, local search text, active
filter, sort order, collapsed sections):

- presentation behavior
- not canonical Project workflow state

UI preferences must not be modeled as shared Project workflow
configuration.

### 3a.7. API contract (implemented)

WorkItem reads and writes reference stable definition IDs, not
display-name strings:

```text
typeDefinitionId
statusDefinitionId
labelDefinitionIds[]
```

rather than globally fixed identifiers such as `"Task"`, `"Writing"`, or
`"Urgent"`. Legacy fixed-string `type` / `status` values are not part of the
canonical contract; do not write logic that branches on them.

### 3a.8. Migration (completed)

The earlier Core implementation stored WorkItem `type` and `status` as
fixed strings. That migration is now complete: every Project has local
TypeDefinitions and StatusDefinitions, and every WorkItem references the
corresponding definition for its Project via `type_definition` and
`status_definition` foreign keys.

Legacy fixed-string `type` / `status` values are **not** part of the
canonical contract. New logic must not branch on legacy strings; it must use
the definition IDs.


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

WorkItem types and statuses are defined per Project (see Section 3a).
Each Project maintains its own WorkItemTypeDefinitions and
WorkItemStatusDefinitions.

### 6.1. WorkItem Type

A WorkItem references exactly one WorkItemTypeDefinition belonging to
its Project. The Project is the configuration boundary.

Newly created Projects receive default TypeDefinitions:

- Epic (kind `epic`) — large initiative/work area
- Milestone (kind `milestone`) — important project checkpoint/target
- Deliverable (kind `deliverable`) — concrete result to deliver
- Task (kind `task`) — concrete executable work

Project owners may create additional Types or rename existing ones.
Renaming changes only the display name; the canonical kind of a default
definition is unchanged, and custom Types carry no canonical kind
(see Section 3a.1).

### 6.2. WorkItem Status

A WorkItem references exactly one WorkItemStatusDefinition belonging to
its Project.

Each StatusDefinition carries a fixed semantic category:

- todo
- in_progress
- review
- done

The visible name is configurable. The category is not.

Newly created Projects receive default StatusDefinitions:

- "Todo" (category: todo)
- "In Progress" (category: in_progress)
- "Review" (category: review)
- "Done" (category: done)

## 7. Work Item conceptual API model

```ts
type WorkItem = {
  id: string

  projectId: string

  typeDefinitionId: string
  statusDefinitionId: string
  labelDefinitionIds: string[]

  title: string
  description?: string

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

The API shape does not prescribe PostgreSQL storage.

`typeDefinitionId` and `statusDefinitionId` reference Project-scoped
configuration definitions, not globally fixed string enums.

`labelDefinitionIds` is an API representation of the many-to-many
relationship. The database stores a relational join table.

The canonical UI must resolve the display names and categories from
the referenced definitions. When a broad system category is needed
(e.g., completion reasoning, dashboard projections), the system uses
the StatusDefinition's semantic category.

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

**Custom "Blocked" Status.** A Project may define a custom visible
status named "Blocked" (or similar). This status still carries one
canonical category (e.g., `in_progress`). A custom status named
"Blocked" does NOT replace `blockedReason`.

- `blockedReason` answers: *why is this WorkItem blocked?*
- A "Blocked" status answers: *which workflow column does this
  WorkItem sit in?*

Both concepts can coexist independently.

## 12. Completion semantics

Completion is derived from the referenced StatusDefinition's semantic
category.

When a WorkItem's status_definition.category changes to `done`:

```text
completed_at is set server-side
```

When a WorkItem's status_definition.category changes from `done` to a
non-`done` category:

```text
completed_at is cleared
```

A transition between two statuses whose categories are both `done`
does not clear `completed_at`.

`completed_at` is server-managed. The client must not set it directly.

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

### Deletion semantics

A Work Item can be permanently deleted by an authorized actor (Project
`owner`/`member` on the Work Item's own Project, non-archived Project).
Deletion is server-authoritative and deny-by-default; a `viewer` and any
user without Project access are rejected.

Deleting a Work Item:

- **Never deletes its Project** and never affects unrelated Work Items.
- Removes Work-Item-owned dependent relations (assignees, label relations,
  comments/activity, and the `MeetingItemWorkItem` origin/link rows).
- **Does not cascade-delete children.** A parent's `parent` relationship is
  `SET_NULL`, so deleting a parent leaves its children in place, now
  unparented. Deleting a child never affects its parent.

Deleting a Work Item that was created from a MeetingItem is one-way: it
removes only the origin link and does **not** delete or mutate the
originating Meeting, MeetingSection, or MeetingItem.

## 14. My Work

My Work is not a separate task database.

It is an authorized projection over Work Items:

```text
WorkItem
WHERE current authenticated user is assignee
AND current user still has Project access
```

My Work is a derived personal view over canonical Project Work
Items. Membership in My Work is never persisted independently; it is
determined by current assignment plus current authorization (current
`WorkItemAssignee` + current `ProjectMembership` `owner`/`member` in
the Work Item's Project + current `ResearchGroupMembership` in the
Project's Research Group). Removing the user as assignee, removing
Project access, or losing the required Research Group access removes
the item from My Work immediately. There is no denormalized My Work
membership table and no cached membership snapshot.

The global My Work Kanban will group by semantic status category
while retaining each Work Item's concrete project-local status: the
My Work read API returns both the concrete Project StatusDefinition
(`statusDefinitionId` + `statusName`) and that definition's fixed
semantic category (`statusCategory`: `todo` / `in_progress` /
`review` / `done`). The concrete project status is never collapsed
into the global category, and the canonical Work Item type payload
(`typeDefinitionId`) is preserved; the read API also carries the
concrete project-local type name (`typeName` — the display name of
the Work Item's Project `WorkItemTypeDefinition`) as display
metadata for that ID, plus the definition's stable semantic kind
(`typeKind`: `task` / `epic` / `milestone` / `deliverable`, or
`null` for custom / unclassified types — Section 3a.1). The
`typeKind` is the machine-readable presentation discriminator:
type-specific presentation (icons, colors) must key off `typeKind`,
never off the `typeName` display string.

Global My Work Kanban columns represent semantic status
categories. A cross-category move resolves to the first active
project-local status definition in that category according to that
Project's configured status order, with a stable ID tie-break. The
My Work read API carries that resolution per Work Item as
`statusTargets`: for each fixed semantic category that has at least
one active `WorkItemStatusDefinition` in the Work Item's own
Project, the target is the first such definition in the Project's
configured status order (`order`, stable definition-ID tie-break) —
at most one target per category, inactive definitions never
appear, a category without an active definition is omitted
entirely (no artificial statuses are invented), and status display
names never participate in resolution. Targets are derived on read
from the canonical Project `WorkItemStatusDefinition` rows (no
persisted My Work target table, no cached mapping), so changing a
Project's status configuration automatically changes future My
Work target resolution. The current concrete
`statusDefinitionId` remains authoritative for the Work Item
itself, and no My Work mutation-by-category semantics exist: a
move uses the target's `statusDefinitionId` through the existing
canonical Work Item mutation path.

My Work has no independent persisted card ordering. Project
`boardPosition` remains project-local and is never used to choose a
global status target; moving a card within the same global semantic
category does not persist any My Work ordering.

Possible UI filters:

- All
- Today
- Overdue
- Blocked
- Done

No `MyWorkTask` entity is created.

## 14a. My Work preferences (server-side personal view state)

My Work preferences are personal view state over the canonical Work
Items, persisted server-side per user (NOT localStorage), so they
survive navigation, reload, logout/login, and device changes.

Persisted per user (one row per user):

```text
MyWorkPreferences

user_id          (one-to-one with the User)
view_mode        board | list
research_groups  (selected Research Groups; relational)
projects         (selected Projects; relational)
work_item_types  (selected semantic type kinds; validated set)
created_at / updated_at
```

- **Board vs List is part of the persisted preference.** `view_mode`
  is exactly `board` or `list`; anything else is rejected.
- **Empty filter arrays mean "no restriction" within the user's
  current access.** `researchGroupIds = []` means all currently
  accessible Research Groups; `projectIds = []` means all currently
  accessible Projects; `workItemTypes = []` means all semantic Work
  Item types.
- **Semantic type kinds only.** `workItemTypes` holds ONLY canonical
  semantic kind values from `WorkItemTypeDefinition.Kind`
  (`task` / `epic` / `milestone` / `deliverable`). Type display
  names — including canonical-looking names on custom
  (kind-less) definitions — are never persisted and never
  interpreted as semantic kinds (Section 3a.1).
- **Current access always wins over stored preferences.** Every
  read and write is constrained by the user's CURRENT access:
  Research Group selections retain only groups the user currently
  belongs to; Project selections retain only Projects the user
  currently has effective access to under the canonical Project +
  Research Group membership rules; and — when a non-empty Research
  Group selection exists — selected Projects must also belong to
  one of those selected groups.
- **Stale selections are sanitized on the next load, and the
  cleaned state is persisted.** Losing a Research Group membership
  removes that group (and Projects invalidated by the surviving
  group filter) from the preference on the next load; losing
  Project access removes that Project. The sanitized preference
  state becomes the persisted state; stale inaccessible IDs are
  never returned as if still valid.
- **Preferences are never authorization.** They grant no
  membership, never grant access to any Research Group, Project, or
  Work Item, and never restore lost access. They never mutate Work
  Items, assignments, statuses, Memberships, or Project/Research
  Group data. `GET /api/me/work-items/` is unaffected by stored
  preferences.

API (authenticated; the client contract is a COMPLETE current
snapshot, not incremental toggle actions — a PATCH persists the
complete normalized state atomically and returns it):

```text
GET   /api/me/preferences/my-work/
PATCH /api/me/preferences/my-work/

{
  "viewMode": "board" | "list",
  "researchGroupIds": [...],
  "projectIds": [...],
  "workItemTypes": [...]
}
```

A first GET for a user with no preference row returns the default
snapshot (`board` + three empty filter arrays).

The user-facing My Work filter toolbar (Research Group / Project /
Type filter controls, chips, and client-side filtering over the My
Work payload) is follow-up work; this section defines the
persistent backend preference domain and API foundation only.

## 15. Project Board (implemented)

The Project Board is a projection over the same canonical Project Work Items
shown by the Project List and My Work. Board and List are views over one data
source; switching views must not create separate state.

### Columns

A Board column corresponds to a **Status Definition**
(`WorkItemStatusDefinition`), identified by `statusDefinitionId`. An item is
placed in the column of its current `statusDefinitionId`.

### Manual ordering (persisted)

Manual ordering is persisted on the Work Item via `board_position`
(`Integer`, nullable). Ordering is meaningful within one Project/status
column. A column renders by `(board_position ASC NULLS LAST, created_at, id)`:
explicitly positioned items first, then unpositioned items in canonical
creation order. `board_position = NULL` means "unsorted".

- Items can be reordered within a column.
- An item can be inserted at an exact position, including across columns
  (a cross-column drag).

### Cross-column drag (one atomic operation)

`reposition_work_item` performs a single atomic Board operation that changes
the Work Item's `status_definition` (when the target column differs) and its
`board_position` together, so a cross-column drop can never be split into a
racy status update followed by a separate position update. On each reorder the
target column is normalized to explicit positions 1…N in render order.
The server remains authoritative for status and ordering.

`before_work_item_id` (API: `beforeWorkItemId`) anchors the insertion: the
moved item is placed immediately before that Work Item; `null` means the end
of the target column.

### Board ↔ Editor invariant

The Board column, the Work Item Editor status, the Work Item's
`statusDefinitionId`, and the persisted backend state must always agree.
Changing the status in the Editor moves the item to the target column;
changing the column on the Board updates the canonical status.

### Editor status change placement (implemented)

Changing status through the Work Item Editor sends a `statusDefinitionId`
patch (the editor resolves the chosen status category to the Project's
matching Status Definition) and does not send an insertion anchor. The server
then appends the item to the **end** of the target column. Board drag/drop
uses `reposition_work_item` instead, which honors an explicit insertion
anchor.

### Status-only transition (preserves board position, implemented)

There are three explicit mutation modes for a Work Item status change;
each is a dedicated operation, so the distinction is intentional and
never inferred from caller identity:

- **Editor status update** (`update_work_item`, a `statusDefinitionId`
  patch) repositions the status-changed item to the **end** of the target
  column. This is the Project-context editor/drawer path.
- **Board drag** (`reposition_work_item`, `POST /api/work-items/{id}/reorder/`)
  sets an **exact** insertion position (and changes status on a
  cross-column drop).
- **Status-only transition** (`transition_work_item_status`,
  `POST /api/work-items/{id}/transition-status/`) changes the concrete
  `statusDefinitionId` **without** changing the Work Item's
  `board_position`, without reordering or renumbering any sibling, and
  without performing a Project-board reposition.

The status-only transition exists because a global cross-category status
change (for example, from My Work) must move the canonical Work Item status
without silently reordering the Project Kanban. A project-local
`board_position` is per-Project ordering metadata and must not be a side
effect of a global status change. It is therefore a **canonical Work Item
capability** — a dedicated endpoint on the canonical Work Item resource —
not a My Work-specific mutation endpoint, and it introduces no My
Work-specific persisted state.

**Semantics.** The target must be an existing `WorkItemStatusDefinition`
belonging to the Work Item's Project (the same-Project invariant, section
3a.4) and must be active (an inactive status cannot be selected as a new
transition target, section 3a.2). Authorization is identical to the ordinary
update path (PROJECT_WORK: owner/member, not viewer; archived Projects are
read-only). `completed_at` follows the target category through the canonical
completion semantics (section 12). A transition to the current status is a
no-op and records no history; a real change records exactly one
`work_item.updated` event carrying the `statusDefinition` from/to (with the
fixed semantic `category`), identical to the ordinary update path —
`board_position` never appears in the history diff.

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
9. Every WorkItem references a WorkItemTypeDefinition belonging to its own Project.
10. Every WorkItem references a WorkItemStatusDefinition belonging to its own Project.
11. Every WorkItem label belongs to the WorkItem's own Project.
12. Knowing a Definition ID must not bypass Project authorization.
13. Every Work Item assignee is a Project Owner or Member.
14. A Viewer cannot be an assignee.
15. Work Item parent/child relations stay inside one Project.
16. Work Item hierarchy is acyclic.
17. `blocked` is derived from `blockedReason`, not a workflow status.
18. A StatusDefinition's category is immutable once referenced by a WorkItem.
19. Each Project has exactly one active default StatusDefinition (category `todo`).
20. `completed_at` is set when status_definition.category becomes `done`; cleared when it leaves `done`.
21. My Work and Project Board reference the same Work Items.
22. API ID lists do not imply PostgreSQL foreign-key arrays.
23. Many-to-many relationships are relational.
24. Project authorization is enforced by the server.
25. Permission-filtered list endpoints do not leak private resources.
26. A WorkItemTypeDefinition's semantic kind is system-assigned only at canonical default creation, is never editable through the configuration API, and is never inferred from the display name — not at runtime and not during data migration; legacy definitions without provable machine-readable semantic provenance have `kind = null`.
27. My Work preferences are server-side personal view state, never authorization: every read/write is re-sanitized against the user's CURRENT Research Group / Project access and the canonical semantic type kinds, stale inaccessible selections are removed and persisted as removed on the next load, and preferences never grant access to or mutate any Research Group, Project, Work Item, assignment, or Membership (Section 14a).

## 20. Core acceptance flow

The Foundation is complete only when this end-to-end scenario works:

```text
Alex logs in
→ creates Paper XYZ
→ Paper XYZ receives default WorkItem configuration
  (Epic, Milestone, Deliverable, Task;
   Todo, In Progress, Review, Done)
→ Alex becomes Owner
→ adds Chris as Member
→ creates "Rewrite Introduction" (type: Task, status: Todo)
  assigned to Chris

Chris logs in
→ sees Paper XYZ
→ sees "Rewrite Introduction" in My Work
→ sees the same Work Item in Paper XYZ

Maria logs in
→ cannot see Paper XYZ
```

Paper XYZ:

- has its own default WorkItem configuration.
- "Rewrite Introduction" is the SAME canonical WorkItem in both
  My Work and Project Board.
- WorkItem type is the Project's Task TypeDefinition.
- WorkItem status is the Project's Todo StatusDefinition.

Do not start the Meeting domain before this flow is reliable.
