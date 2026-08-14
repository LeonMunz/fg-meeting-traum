# FG Workspace — Product

## Product vision

FG Workspace is a lightweight operating system for research groups.

It connects the things that belong together in day-to-day research-group work:

```text
People
  ↕
Research Group
  ↕
Projects
  ↕
Work
  ↕
Meetings
  ↕
Decisions and follow-ups
```

The product should not reproduce Jira, Notion, OpenProject, SharePoint, or a complete enterprise suite.

The central promise is:

> Information from meetings and projects becomes clearly owned, traceable work without independently maintaining the same information in multiple places.

FG Workspace is also a Living Lab. Product behavior and UX are expected to evolve from observed use.

## Organizational model

```text
Research Group
│
├── Members
├── Group-level Meetings
├── Group-level Topics
├── KVP
└── Projects
    │
    ├── Project Members
    ├── Project Permissions
    ├── Work Item Configuration
    │   ├── Types
    │   ├── Statuses
    │   └── Labels
    ├── Project Meetings
    ├── Project Topics
    └── Work Items
```

The Research Group is the shared organizational space.

A Project is a separate, protected work space inside the Research Group.

Each Project maintains its own WorkItem configuration: types, statuses,
and labels. Project A configuration is independent from Project B
configuration.

These levels must not be conflated.

## Product principles

### Research Group membership is not Project access

A user can belong to the Research Group without belonging to every Project.

Project workspaces are private by default.

### Every Research Group member may create a Project

An active Research Group member may create a Project.

The creator automatically becomes a Project Owner.

The Owner controls which other Research Group members receive Project access.

### All Work Items are project-bound

There are no projectless Tasks, Deliverables, Milestones, or Epics.

Every Work Item belongs to exactly one Project.

This also applies when work is created from a Meeting.

### One canonical Work Item

My Work, Project Board, Dashboard, and Meeting contexts show projections of the same Work Item.

They do not maintain screen-specific task copies.

### Meetings build on the project/work foundation

Meetings are not the first fundamental feature.

The system first validates:

```text
Identity
→ Research Group
→ Project
→ Project Membership
→ Work Item
→ Assignment
→ My Work
```

Meetings later create and discuss work inside that already functioning permission and project model.

## First product milestone — Core checkpoint

The first milestone is:

> Identity, Research Group, Project isolation, assignment, and personal work function together as a real multiuser system.

Acceptance flow:

```text
Alex logs in
  ↓
creates Paper XYZ
  ↓
becomes Owner
  ↓
adds Chris as Member
  ↓
creates "Rewrite Introduction"
assigned to Chris
  ↓

Chris logs in
  ↓
sees Paper XYZ
  ↓
sees the Work Item in My Work
  ↓
sees the same Work Item in the Project Board

Maria logs in
  ↓
does not see Paper XYZ
```

Meetings are not implemented before this flow is reliable.

## Second product milestone — Meeting integration

After the Core checkpoint:

```text
FG Weekly
    ↓
Topic
    ↓
MeetingItem
    ↓
Decision / Follow-up
    ↓
Create Work Item
    ↓
Project X
    ↓
Chris
    ↓
My Work
    ↓
Project Board
```

There must be no meeting-specific parallel work system.

## Core scope

The first product phase includes:

- authenticated user identity
- Research Group
- Research Group Membership
- Project
- Project Membership
- Project roles
- Work Item
- Work Item assignment
- My Work
- Project Board
- server-side authorization

After the Core checkpoint:

- MeetingSeries
- Meeting
- MeetingParticipant
- Topic
- MeetingItem
- Meeting → Work Item
- follow-up/history

## Later product areas

These remain valid product directions but are not required for the Core checkpoint:

- KVP
- Goals
- Knowledge
- Documents
- Calendar
- Search
- integrations
- automation
- AI

## Explicitly not Core scope

Do not implement before a validated need:

- generic RBAC engine
- microservices
- realtime collaboration
- WebSockets
- event sourcing
- portfolio management
- cross-project work-item hierarchies
- configurable workflow engines
- full audit platform
- wiki
- full-text search infrastructure
- SharePoint / OneDrive / Sciebo integration
- calendar-provider integration
- scheduling polls
- AI summarization
- notifications service
- analytics platform
- recommendation engine

## Definition of success — Core

A Research Group member can reliably understand:

- who they are,
- which Research Group they are working in,
- which Projects they may access,
- which Projects they may not access,
- which Work Items are assigned to them,
- which Project each Work Item belongs to,
- who the Project members are,
- the state of the work,
- where the same Work Item appears in different views.

## Definition of success — Meeting extension

In addition, users can understand:

- which Topic was discussed,
- in which Meeting,
- which notes and decision resulted,
- whether follow-up is required,
- which Work Item was created,
- which Project owns it,
- who is assigned,
- whether it was discussed again,
- which historical MeetingItems belong to the Topic.
