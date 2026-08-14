# FG Workspace — Testing & Living Lab

## Purpose

The Living Lab validates whether the product model and UX work for real research-group coordination.

The goal is product learning, not feature count.

Until institutional privacy/hosting requirements are resolved, use synthetic test data.

## Testing strategy

Tests are part of development, not a later hardening activity.

Prioritize business rules and authorization over broad visual snapshot testing.

## Domain tests

### Project

- Project creator becomes Owner.
- A non-Research-Group member cannot become ProjectMember.
- An active Project never loses its last Owner.

### Work Item

- Project is mandatory.
- Assignee must be Project Owner or Member.
- Viewer cannot be assigned.
- Parent belongs to the same Project.
- Parent hierarchy cannot cycle.
- `blockedReason` present → blocked; empty → not blocked.
- `completed_at` set when status_definition.category becomes `done`.
- `completed_at` cleared when status_definition.category leaves `done`.

### WorkItem Configuration

- Every new Project receives default TypeDefinitions: Epic, Milestone,
  Deliverable, Task.
- Every new Project receives default StatusDefinitions: Todo (default,
  category todo), In Progress (in_progress), Review (review), Done (done).
- A Project owner may create, rename, reorder, and deactivate Types,
  Statuses, and Labels.
- A Project member may read configuration but not mutate it.
- A Project viewer may read configuration but not mutate WorkItems.
- A StatusDefinition's category is immutable once referenced by a WorkItem.
- Each Project has exactly one active default StatusDefinition (category
  `todo`). Deactivating it is forbidden without a replacement.
- Deactivating a used Type, Status, or Label does not affect existing
  WorkItems. The definition remains readable.
- WorkItem labels are a relational many-to-many join.
- Cross-Project configuration assignment is forbidden.
- Project A configuration is independent from Project B configuration.

### Meeting

After Meeting implementation:
- Project Meeting contains only users with Project access.
- Group Meeting does not expose private Project objects.
- Meeting with a `discussing` item cannot end.
- Topic is not automatically resolved from Work Item state.

## Permission tests

For protected Project resources, test at least:

- Owner
- Member
- Viewer
- no ProjectMembership
- user from another Research Group

Cover relevant actions such as:
- list
- get
- create
- update
- membership changes

The critical property is not only returning `403` for detail access; list endpoints must also avoid leaking inaccessible objects.

## Integration tests

Core cross-feature flow:

```text
Project
→ Work Item
→ My Work
```

Later:

```text
Meeting
→ Work Item
→ My Work
→ Project Board
```

## E2E priority

The first E2E target is the Core checkpoint:

```text
Alex logs in
→ creates Paper XYZ
→ becomes Owner
→ adds Chris
→ assigns Chris a Work Item

Chris logs in
→ sees Paper XYZ
→ sees the Work Item in My Work
→ sees the same Work Item in Project Board

Maria logs in
→ cannot see Paper XYZ
```

Automate this browser flow once the underlying product slice is stable enough that the E2E test provides value.

## Seed data

Maintain reproducible backend seed data for development and Living-Lab testing.

Suggested synthetic baseline:

Research Group:
```text
FG Example
```

Users:
```text
Alex
Chris
Maria
Laura
```

Projects:
```text
Paper XYZ
- Alex: owner
- Chris: member

Teaching Tool
- Maria: owner
- Laura: member
```

Add Work Items in several states when Work Items exist.

After Meetings exist, add:
- one Weekly
- several Topics
- representative MeetingItems

Seed data is not a second business logic implementation. It must obey the same domain rules as normal data.

## Reset

The Living-Lab test environment needs a documented reset to the baseline seed state.

This allows repeated sessions to start from comparable data.

Reset must be restricted to development/test environments.

## Environments

At minimum:

```text
Development
Living Lab / Test
```

The Living-Lab environment uses:
- PostgreSQL persistence
- migrations
- authenticated users
- server-side authorization

A test session should be attributable to an identifiable product version/commit.

## Living-Lab tasks

Core tasks:

### Task 1
Create a new Project and add Chris.

### Task 2
Create a Work Item for Chris inside that Project.

### Task 3
Chris finds the Work Item in My Work.

### Task 4
Chris opens the same Work Item in the Project Board.

### Task 5
Maria attempts to find/access the Project.

Expected:
```text
no access
```

Later Meeting tasks:

### Task 6
Create a Work Item from a discussed Weekly item.

### Task 7
Find the previous decision/history for an open Topic.

### Configuration: Task A — Default Project Configuration
Create a new Project. Verify it receives:

- TypeDefinitions: Epic, Milestone, Deliverable, Task
- StatusDefinitions: Todo (default), In Progress, Review, Done
- No labels initially
- Todo is the active default status (category `todo`)

### Configuration: Task B — Project Customization
As Project owner, add:

- Type: "Experiment"
- Status: "PI Review" (category: review)
- Label: "Reviewer Response"

Verify:
- A Project member may use these definitions on WorkItems.
- A Project viewer may read them but cannot configure them.

### Configuration: Task C — Project Isolation
Customize Paper XYZ with additional types, statuses, and labels.
Verify that another Project retains its own unchanged configuration.
No Definition may cross Project boundaries.

### Configuration: Task D — Custom Done Semantics
As Project owner, create:

- Status: "Accepted" (category: done)

Move a WorkItem from a non-done status to "Accepted".
Verify `completedAt` becomes populated.

Move the same WorkItem from "Accepted" to a status whose category is
`review`. Verify `completedAt` becomes null.

### Configuration: Task E — Status Category Immunity
Create a StatusDefinition and assign it to at least one WorkItem.
Attempt to change its semantic category.
Expected: rejected.
Rename remains allowed.

### Configuration: Task F — Deactivation
Deactivate a Type, Status, or Label that is referenced by at least one
WorkItem. Verify:

- The existing WorkItem retains its reference.
- The definition remains readable.
- The definition cannot normally be selected for new WorkItems.
- No automatic WorkItem mutation occurs.

### Configuration: Task G — Default Status Safety
Attempt to deactivate the active default status without first assigning
another valid active `todo` default.
Expected: rejected.

### Configuration: Task H — Privacy
A ResearchGroup admin without ProjectMembership attempts to inspect
the WorkItem configuration of a private Project.
Expected: no access.
Knowing Definition IDs must not bypass Project privacy.

### Configuration: Task I — Single Source of Truth
Verify the same WorkItem appears in:

- Project Work Items view
- My Work view

Both views must show the same WorkItem ID, same TypeDefinition, same
StatusDefinition, and same Labels. No projection-specific copies.

## Observed metrics

Per task, capture as useful:

- success/failure
- completion time
- misclicks
- questions
- visible uncertainty
- abandonment
- qualitative comments
- requested improvements

The purpose is to identify product and UX problems.

## Privacy and real data

A hosted Living Lab may process:

- names
- roles
- Project memberships
- tasks/work responsibilities
- Meeting notes
- decisions

Before using real research-group data, clarify:

- hosting
- access control
- institutional privacy requirements
- retention
- deletion
- backups

Use synthetic data until this is resolved.

## Hardening before real group use

Before real research-group use, ensure:

- reproducible deployment
- stable migrations
- seed/reset for test environments
- error handling
- authorization coverage
- backup approach
- privacy/hosting decision
- identifiable test version
