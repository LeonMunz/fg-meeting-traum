# FG Workspace — Meeting Domain

This document becomes implementation-relevant **after** the Core checkpoint in `domain/foundation.md`.

Meetings build on the already working identity, Project, membership, authorization, and Work Item foundation.

## 1. Meeting scope

A Meeting has an explicit scope:

```ts
type MeetingScope =
  | 'group'
  | 'project'
```

### Group Meeting

```text
scope = group
project_id = NULL
```

The Meeting belongs to the Research Group.

Participants must be Research Group members.

Example:
- FG Weekly

### Project Meeting

```text
scope = project
project_id IS NOT NULL
```

The Meeting is private Project context.

Participants must have Project access.

## 2. Meeting model

Conceptual relational model:

```text
Meeting

id
research_group_id
scope
project_id NULLABLE
series_id NULLABLE
title
status
scheduled_start_at
scheduled_end_at
started_at
ended_at
moderator_id
created_at
updated_at
created_by_id
```

Constraint:

```text
scope = group   → project_id IS NULL
scope = project → project_id IS NOT NULL
```

Status:

```ts
type MeetingStatus =
  | 'upcoming'
  | 'live'
  | 'completed'
```

## 3. Meeting participants

Participants are relational, not a PostgreSQL ID array.

```text
MeetingParticipant

meeting_id
user_id
```

Constraint:

```text
UNIQUE(meeting_id, user_id)
```

For a group Meeting, every participant must be a Research Group member.

For a Project Meeting, every participant must have Project access.

## 4. Moderator

A Meeting has a moderator.

For a group Meeting, the moderator must be a Research Group member.

For a Project Meeting, the moderator must also have sufficient Project access.

The moderator controls:
- Start Meeting
- active agenda item
- completion/follow-up of the active item
- End Meeting

This is not a generic permissions engine.

## 5. Meeting lifecycle

Start:

```text
upcoming → live
started_at = now
```

End:

```text
live → completed
ended_at = now
```

A Meeting cannot end while any MeetingItem is:

```text
discussing
```

The active item must first become:

```text
done
```

or:

```text
follow_up
```

Undiscussed items may remain.

## 6. MeetingSeries

Recurring Meetings may be grouped by a MeetingSeries.

```text
MeetingSeries

id
research_group_id
scope
project_id NULLABLE
title
type
created_at
```

Example:

```text
FG Weekly Series
├── Weekly 13.08.
├── Weekly 20.08.
└── Weekly 27.08.
```

A MeetingSeries is not a historical Meeting occurrence.

Its scope/project constraints follow the same semantics as Meeting.

## 7. Topic

A Topic is a durable discussion subject that can appear in multiple Meetings.

It is not a MeetingItem.

Example:

```text
Topic "GPU procurement"
├── MeetingItem 13.08.
├── MeetingItem 20.08.
└── MeetingItem 27.08.
```

### TopicScope

```ts
type TopicScope =
  | 'group'
  | 'project'
```

Group Topic:

```text
scope = group
project_id = NULL
```

Project Topic:

```text
scope = project
project_id IS NOT NULL
```

Project Topics are protected Project content.

## 8. Topic model

```text
Topic

id
research_group_id
scope
project_id NULLABLE
title
description
status
created_at
updated_at
created_by_id
```

Status:

```ts
type TopicStatus =
  | 'open'
  | 'resolved'
```

Topic state is not derived automatically from Work Item completion.

## 9. MeetingItem

A MeetingItem records what happened with one agenda point in one concrete Meeting.

It is a historical snapshot.

```text
MeetingItem

id
meeting_id
topic_id NULLABLE
title
section
origin
status
notes
decision
order
created_at
created_by_id
```

### Sections

Initial Weekly sections:

```text
announcement
project_update
topic
kvp
spontaneous
```

Sections are domain semantics, not merely visual headings.

### Origin

```text
planned
spontaneous
```

This is independent from section.

### Status

```text
not_discussed
discussing
done
follow_up
```

MeetingItem status answers:

> What happened to this point in this specific Meeting?

It does not represent Topic state or Work Item state.

## 10. Notes vs decision

`notes` and `decision` are distinct information.

Do not merge them into one field merely for UI convenience.

Historical MeetingItems must remain stable even if a linked Topic later changes.

## 11. Topic vs MeetingItem vs WorkItem

The three state models are independent.

### Topic

```text
open / resolved
```

Question:
> Is the durable topic still open?

### MeetingItem

```text
not_discussed / discussing / done / follow_up
```

Question:
> What happened in this Meeting?

### WorkItem

```text
todo / in_progress / review / done
```

Question:
> What is the state of the resulting work?

Do not automatically equate these states.

In particular:

```text
all linked Work Items done
≠
Topic automatically resolved
```

## 12. Follow-up

A MeetingItem with:

```text
status = follow_up
```

means the point is closed for the current Meeting but needs future attention.

A follow-up does not necessarily create a Work Item.

It must, however, have a durable continuation point.

If no Topic exists, carry-over requires creation/confirmation of a Topic.

## 13. Carry-over snapshot model

A durable Topic may appear as a new MeetingItem in a later Meeting.

```text
Topic A
├── MeetingItem Weekly 13.08.
├── MeetingItem Weekly 20.08.
└── MeetingItem Weekly 27.08.
```

Each MeetingItem preserves:
- notes
- decision
- order
- status
- historical Meeting context

The Topic provides continuity.

## 14. Agenda materialization

When preparing a new Meeting, suitable open Topics may be materialized into new MeetingItems.

The agenda is not dynamically recomputed from all open Topics every time it is opened.

This allows the next agenda to be:
- prepared
- reordered
- extended
- annotated

without mutating previous Meetings.

## 15. Agenda order

Initial ordering uses an integer:

```text
order
```

For small Weekly agendas, re-index affected items after drag-and-drop.

Do not introduce fractional ranking unless real scale/concurrency requires it.

## 16. Project isolation in Meetings

This is security-critical.

> Referencing Project data in a group Meeting must not make private Project data visible to users without Project access.

A group Meeting must not directly expose private:
- Project objects
- Project Topics
- Work Items
- Project decisions
- Project Meeting history

The server enforces this boundary.

## 17. Project Updates in FG Weekly

The group-level `project_update` section is allowed.

Its content is explicitly group-level information.

Example:

> "Paper submission is planned for September."

It is not an automatic projection of private Project data.

The UI/server must not automatically load private Tasks, Project Topics, or internal decisions into a group Meeting.

Direct work with private Project objects belongs in a Project Meeting/context.

## 18. Meeting → Work Item

Later core flow:

```text
MeetingItem
    ↓
Create Work Item
    ↓
Project (mandatory)
    ↓
Type
    ↓
Assignee
    ↓
Due Date
    ↓
Create
```

The server checks:

1. authenticated user has write access to the selected Project,
2. every assignee is Project `owner` or `member`,
3. the MeetingItem is visible to the current user,
4. no Project isolation rule is violated.

## 19. Work Item origin

If a Work Item is created from a MeetingItem:

```text
source_meeting_item_id
```

records the single origin event.

Meaning:

> This Work Item was created from this concrete MeetingItem.

## 20. Later Work Item discussions

An existing Work Item may be discussed again in later Meetings.

Model this relationally:

```text
WorkItemDiscussion

work_item_id
meeting_item_id
```

Origin and later discussion are different semantics.

Example:

```text
Weekly 1 → Task created
Weekly 3 → existing Task discussed
```

Then:
- source = Weekly 1 MeetingItem
- discussion = Weekly 3 MeetingItem

## 21. Meeting invariants

1. Group Meeting has no `project_id`.
2. Project Meeting has a `project_id`.
3. Project Meeting participants have Project access.
4. Group Meeting participants belong to the Research Group.
5. Project Topic remains private Project content.
6. Group Meeting does not expose private Project objects.
7. Project update text in a group Meeting is explicitly group-level content.
8. MeetingItem belongs to exactly one Meeting.
9. Topic and MeetingItem are different entities.
10. MeetingItems remain historical snapshots.
11. Topic may appear in multiple MeetingItems.
12. Meeting cannot end while an item is `discussing`.
13. Topic is not automatically resolved from Work Item status.
14. Follow-up preserves a durable Topic connection.
15. Work Item creation from Meeting always requires a Project.
16. Meeting → Work Item obeys Project write and assignee permissions.
17. Work Item origin and later discussion are separate relations.
18. Meeting and Topic queries must not leak inaccessible Project data.
