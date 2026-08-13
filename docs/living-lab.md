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
- `done` sets `completed_at`.
- reopening clears `completed_at`.

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
