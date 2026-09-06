# FG Workspace — Meetings

**Status:** Canonical Meeting domain specification
**Scope:** Meeting templates, Meeting, Sections, MeetingItems, lifecycle, Work Item integration, permissions, privacy and implementation boundaries

> **User-facing terminology:** the product exposes `Research Group Meeting`, `Project Meeting`, and `Meeting Templates`. Internally, a `Meeting Template` is persisted as a `MeetingSeries`. No recurrence semantics are implemented, and no `MeetingSeries` may be presented to users as "Series" or implied to auto-create recurring Meetings. When this document (or other canonical docs) uses the word “Series”, it refers to the internal `MeetingSeries` persistence model, not a user-facing concept; user-facing copy must say “Meeting Template”.

---

## 1. Purpose

FG Workspace is a lightweight operating system for research groups.

The Meeting area is not a standalone meeting-notes product. Its purpose is to connect conversation to durable context, decisions and canonical project work:

```text
Prepare
  ↓
Discuss
  ↓
Decide / identify follow-up
  ↓
Create or link canonical Work Item
  ↓
Work happens in Project / My Work
  ↓
Relevant state returns to the next Meeting
```

The core product promise is:

> Information from meetings becomes clearly owned, traceable work without maintaining the same information independently in meeting notes and project-management views.

The Meeting MVP must therefore optimize the full recurring lifecycle rather than only note taking.

---

## 2. Non-negotiable product principles

### 2.1 Meetings build on the existing work foundation

Meetings are implemented only after identity, Research Group, Project isolation, Project Membership, Work Items, assignment and My Work function reliably.

```text
Identity
→ Research Group
→ Project
→ Project Membership
→ Work Item
→ Assignment
→ My Work
→ Meetings
```

The Meeting feature must not create an alternative task system.

### 2.2 One canonical Work Item

A Work Item created from a Meeting is the same Work Item later shown in:

- Project Board
- Project List
- Project Map
- My Work
- Work Item Inspector
- Meeting follow-up context

There is no meeting-specific task copy and no synchronization layer between a “meeting task” and a “project task”.

### 2.3 Every Work Item remains project-bound

There are no projectless Work Items.

A Work Item created during a Meeting must belong to exactly one Project.

For a Project Meeting, the Project is already known and should be prefilled/hidden in the quick-create flow.

For a Research Group Meeting, a target Project must be selected unless the broader product explicitly introduces a shared group-internal Project. The Meeting feature must not silently weaken this invariant.

### 2.4 Context should fill fields

The system should derive or prefill information already known from context.

Examples:

```text
Project Meeting
→ Project already known

Current MeetingItem
→ source_meeting_item already known

Current user / Meeting participants
→ sensible assignee candidates already known

Live Weekly action
→ Work Item type defaults to Task when the Project model supports that default
```

A user should not be asked to re-enter information the system already knows.

### 2.5 Few places, no context loss

High-frequency actions must happen within the current Meeting surface.

Do not navigate away from a running Meeting to:

- create a Work Item,
- inspect a Work Item,
- record a decision,
- add a note,
- add a spontaneous Topic,
- mark an agenda item complete.

Use the existing right-side Work Item Inspector/Create Panel for linked work.

### 2.6 Recognition over reconstruction

The system should surface relevant prior context instead of forcing users to reconstruct it from old protocols.

Before or during a later Meeting, show:

- previous decision,
- last discussion,
- linked Work Item and current status,
- whether a Topic remains open,
- whether follow-up is still relevant.

Do not require users to open and reread a previous Meeting transcript or long note.

### 2.7 Meetings must survive imperfect usage

The product must work even when users do not follow an ideal ceremony.

Examples:

- nobody presses “Start Meeting” on time,
- the moderator forgets “End Meeting”,
- a Topic is added shortly before or during the Meeting,
- someone adds a note after the Meeting,
- an agenda item remains undiscussed,
- a user closes the browser mid-edit.

The Meeting state machine must support real behavior rather than punish it.

### 2.8 Research informs direction, not exact UI truth

Research on agendas, cognitive offloading, interruptions, production blocking and psychological safety supports several high-level directions in this concept.

It does **not** prove that a specific UI control, number of intent values or exact workflow is optimal.

Product decisions remain hypotheses to validate in the Living Lab.

---

## 3. Meeting scopes

A Meeting has an explicit scope.

```ts
type MeetingScope =
  | "group"
  | "project"
```

### Research Group Meeting

```text
scope = group
project_id = NULL
```

Example:

```text
FG Weekly
```

Participants must be Research Group members.

The Meeting may contain explicitly group-level information about Projects, but must not leak private Project data.

### Project Meeting

```text
scope = project
project_id IS NOT NULL
```

Participants must have access to that Project.

The Project context is private and may directly reference its Work Items, Topics and decisions.

---

## 4. Core domain concepts

The Meeting domain has distinct concepts with distinct responsibilities.

**Implemented occurrence structure:**

```text
Meeting
    └─ MeetingSection[]
        └─ MeetingItem[]
            └─ MeetingItemWorkItem[]   (historical origin link to a canonical Work Item)
```

These concepts must not be collapsed into one generic “meeting document”. The
`Topic`, `NoteEntry`, `MeetingItemAcknowledgement`, and separate Work Item
discussion-link concepts from the original product concept remain
documented below as intended direction; they are not part of the current
occurrence model.

---

## 5. Meeting Template (internal: `MeetingSeries`)

A **Meeting Template** defines a reusable meeting format such as `FG Weekly`.

It is not a historical Meeting occurrence. A Meeting Template is persisted
internally by the Django model `MeetingSeries`; that name is an internal
implementation detail and is not the user-facing term.

**There are no recurrence semantics.** A Meeting Template does not schedule,
repeat, or automatically create Meetings. Creating an occurrence is always an
explicit action by a user.

Conceptual model (internal persistence):

```text
MeetingSeries

id
research_group_id
scope              group | project
project_id NULLABLE
title
description
is_archived
created_by_id
created_at
updated_at
```

### Responsibilities

A Meeting Template defines:

- identity and purpose,
- group or Project scope,
- the default Meeting structure (its editable Sections),
- the collection of Meeting occurrences created from it.

Not yet implemented on the Template: default participants, moderator rotation,
and Series-level guidance. Those remain intended direction from the product
concept, not current behavior.

### Editable (implemented)

Users with appropriate write access for the Template's scope can change:

- title,
- description,
- archive state,
- Section names,
- Section descriptions,
- Section order,
- active/inactive Sections.

This editability is mandatory for real use.

---

## 6. Editable Meeting structure (Sections)

A Meeting Template has a simple editable structure (its Sections) that is snapshotted into future Meeting occurrences.

This is intentionally **not** a generic schema builder.

### What is configurable in MVP

```text
Section
- name
- optional description
- position
- active/inactive
```

Users can:

- add a Section,
- rename a Section,
- edit its description,
- reorder Sections,
- deactivate/remove a Section.

Example:

```text
FG Weekly structure

≡ Check-In
≡ FYIs
≡ TOPs
≡ Projekte
≡ Akquise
≡ Lehre
≡ Paper
≡ Forschungsgruppe
≡ Tech-News
≡ Fails & Highlights
≡ KVP

+ Add section
```

### What is explicitly not configurable in MVP

Do not build:

- Custom Fields per Section,
- arbitrary field schemas,
- formula fields,
- conditional logic,
- section-specific status machines,
- configurable workflow engines,
- contribution-rule engines,
- section-specific `default_intent`,
- generic template marketplace,
- AI prompt templates,
- arbitrary rendering schemas.

The MVP needs an editable meeting structure, not a low-code meeting platform.

---

## 7. Sections are grouping, not domain semantics

A Section answers:

> Where does this item belong in the familiar meeting structure?

Examples:

```text
FYIs
TOPs
Projekte
Lehre
Paper
KVP
```

A Section does **not** determine the semantic intent of an item.

This avoids duplicated semantics such as:

```text
Section = FYIs
Intent = Decide
```

being treated as invalid or requiring hidden coupling.

The Section is organization.

The `intent` field on the MeetingItem carries the meeting-purpose semantics.

---

## 8. Template guidance / meeting principles

> **Not yet implemented.** A Meeting Template currently has no `guidance_markdown` field. The following is intended direction.

Stable content such as the current FG Weekly “Spielregeln” should not be modeled as ordinary agenda items.

Store it as Series-level guidance:

```text
MeetingSeries.guidance_markdown
```

In the Meeting UI it should normally be collapsed:

```text
▸ Meeting principles
```

If the guidance changes, the UI may surface:

```text
Meeting principles updated
Review changes
```

This preserves the ritual without consuming prime agenda space every week.

---

## 9. Template Sections and MeetingSection snapshots

A Meeting occurrence must retain the structure it actually used.

Template sections are persisted as `MeetingSeriesSection`:

```text
MeetingSeriesSection

id
meeting_series_id
name
description
position
is_active
```

When a concrete Meeting is created from a Template, only **active**
Template Sections are copied into occurrence-level `MeetingSection` records:

```text
MeetingSection

id
meeting_id
source_series_section_id NULLABLE
name
description
position
is_visible
```

This is deliberately not a generic template-versioning engine.

It simply ensures:

```text
August: "Tech-News"
September template renamed to: "Research & Tech"
```

does not silently rewrite the historical August Meeting.

**Snapshot invariants (implemented):**

- Template sections are copied/snapshotted into the Meeting occurrence at
  creation time.
- After creation, the occurrence structure is independent of the Template.
- Editing, reordering, hiding, renaming, or adding Sections on an occurrence
  never mutates the Template.
- A Meeting created without a Template still has a usable structure (see
  Section 10).

### Meeting-specific structure

A concrete Meeting may additionally:

- reorder Sections,
- hide a Section for this occurrence,
- rename a Section for this occurrence,
- add a one-off Section.

Those changes do not mutate the Template.

### Legacy migration invariant (MeetingItem → MeetingSection)

The `MeetingItem.meeting_section` relation is NOT NULL. When it was introduced,
pre-existing (legacy) flat `MeetingItem` rows had to be attached to a valid
`MeetingSection` without guessing at meaning:

- Legacy flat items are **preserved**, never dropped or rewritten.
- They are **not** assigned to unrelated snapshotted Template sections by guesswork.
- A Meeting that had no sections at all receives exactly one occurrence-level
  default Section named `Unsectioned`; its legacy flat items are attached there.
- Items that already referenced a Section were never touched.

This is a one-time migration concern; the rule that matters going forward is
the invariant that every `MeetingItem` must belong to exactly one
`MeetingSection`.

---

## 10. Creating a Template and a Meeting

### Creating a Meeting Template (implemented)

The create flow is small:

```text
New meeting template

Name
[ FG Weekly ]

Scope
● Research group
○ Project   (requires choosing a Project)
```

After creation, the user edits the simple Section list.

### Creating a Meeting (implemented)

A Meeting is created in one of two ways:

- **Standalone** (`create_meeting`): no Template. The Meeting receives a real,
  occurrence-level default Section named `Agenda` (position 0).
- **From a Template** (`create_meeting_from_series`): the Template's active
  Sections are snapshotted into the new occurrence.

Creation requires a Research Group. The Project is optional; the Meeting
Template is optional.

- No Project ⇒ **Research Group Meeting** (`scope = group`, `project_id IS NULL`).
- Selected Project ⇒ **Project Meeting** (`scope = project`, `project_id` set).

Only Templates whose scope matches the chosen Meeting scope (group, or the
specific Project) are offered for selection.

---

## 11. Meeting model (implemented)

A concrete Meeting is one occurrence.

```text
Meeting

id
research_group_id
scope
project_id NULLABLE
series_id NULLABLE          # internal MeetingSeries (Meeting Template)
title
status
current_meeting_item_id NULLABLE
started_at NULLABLE
ended_at NULLABLE
created_by_id
created_at
updated_at
```

`current_meeting_item_id` (exposed in the API as
`currentMeetingItemId`) is the Meeting's persisted **current item**:
the agenda item the Meeting officially points at while Live.

- It is a `OneToOne` reference to exactly one `MeetingItem` of the
  same Meeting (a service-layer invariant), `NULL` when there is no
  current item.
- The referenced item may have **any** outcome
  (`not_discussed`, `done`, `follow_up`): "current" is not an
  outcome, and changing current never mutates any item's outcome.
- Deleting the referenced item clears the pointer
  (`SET_NULL`); deleting the Meeting removes both.
- A frontend-only **Selected** concept (free navigation of the
  agenda rail) is intentionally NOT part of this model: it is
  frontend-local, not persisted, and the corresponding Live UI is
  not implemented yet.

Status:

```ts
type MeetingStatus =
  | "upcoming"
  | "live"
  | "completed"
```

Constraint (enforced by a database check constraint on both `Meeting` and
`MeetingSeries`):

```text
group meeting   → project_id IS NULL
project meeting → project_id IS NOT NULL
```

`moderator_id` is not part of the implemented model (see Section 14).

### `started_at` / `ended_at` semantics (implemented)

- `scheduled_at` is the planned time. It is independent of actual start/end.
- `started_at` is set when the Meeting transitions `upcoming → live`.
- `ended_at` is set when the Meeting transitions `live → completed`.
- Reopening a completed Meeting (`completed → live`) preserves the original
  `started_at` and clears `ended_at`. Ending the reopened Meeting records a
  new `ended_at`.

---

## 12. Meeting-level editing

A concrete Meeting is editable independently from its Meeting Template.

Editable occurrence data:

- title override,
- date/time,
- moderator,
- participants,
- Section visibility/order,
- one-off Sections,
- agenda items,
- agenda-item order.

A change to one Meeting does not automatically alter its Meeting Template.

This distinction must be clear in UX:

```text
Edit this meeting
vs.
Edit series structure
```

---

## 13. Meeting participants (implemented)

Participants are relational.

```text
MeetingParticipant

meeting_id
user_id
added_at
```

Constraint:

```text
UNIQUE(meeting_id, user_id)
```

Research Group Meeting:

```text
participant is a member of the Meeting's Research Group
```

Project Meeting:

```text
participant has read access to the Meeting's Project
```

The creator of a Meeting is automatically added as a participant. Adding a
participant is authorized against the Meeting's scope.

Default participants are not implemented (see Section 14 for the scope of the
implemented model).

Do not build attendance analytics, rankings or performance metrics.

---

## 14. Moderator and moderator rotation

> **Not yet implemented.** The implemented Meeting model has no `moderator` field and no moderator rotation. The following is intended direction.

The moderator controls the live-meeting flow:

- Start Meeting,
- active MeetingItem,
- item completion/follow-up,
- End Meeting.

This is not a generic permissions engine.

### Moderator rotation

A Series may define an ordered rotation:

```text
1 Olli
2 Alex
3 Chris
4 Leon
5 Raffaella
```

Conceptually:

```text
MeetingSeriesModeratorRotation

meeting_series_id
user_id
position
```

The next Meeting receives the next valid moderator as a suggestion/default.

The occurrence can override the moderator without changing the rotation.

At close:

```text
Next moderator
Chris
```

may be shown as a system projection.

---

## 15. Topic

> **Not yet implemented.** There is no `Topic` model in the current backend. Topics are intended direction (see below), not current behavior.

A Topic is a durable discussion subject that may appear in multiple Meetings.

It is not a MeetingItem.

```text
Topic "GPU procurement"

├ MeetingItem 13 Aug
├ MeetingItem 20 Aug
└ MeetingItem 27 Aug
```

Conceptual model:

```text
Topic

id
research_group_id
scope
project_id NULLABLE
title
description_markdown NULLABLE
status
created_at
updated_at
created_by_id
last_deferred_at NULLABLE
defer_count
```

Status:

```ts
type TopicStatus =
  | "open"
  | "resolved"
```

Topic state is not automatically derived from Work Item state.

```text
all linked Work Items done
≠
Topic automatically resolved
```

---

## 16. Topic lifecycle hygiene

Open Topics must not become an endless “topic graveyard”.

The system should support:

```text
Resolve topic
```

When a Topic is repeatedly deferred:

```text
GPU procurement
Deferred 3 times
```

the Preparation UI may move it into:

```text
Older open topics
```

Visibility can decrease automatically.

The Topic must not be automatically marked resolved merely because it was deferred multiple times.

---

## 17. MeetingItem (implemented)

A `MeetingItem` records one agenda point inside one `MeetingSection` of one
concrete Meeting.

**Every `MeetingItem` belongs to exactly one `MeetingSection`.** The
`meeting_section` relation is `NOT NULL`.

```text
MeetingItem

id
meeting_id
meeting_section_id NOT NULL
title
notes
position
outcome
created_by_id
created_at
updated_at
```

`position` is unique within a Section. Items are ordered by
`position`, then `id`.

### Current item and outcome (implemented)

Two distinct, persisted concepts:

- **Current** lives on the `Meeting`
  (`current_meeting_item_id`, API: `currentMeetingItemId`). It
  identifies the agenda item the Meeting officially points at. It
  may reference an item whose outcome is `not_discussed`, `done`,
  or `follow_up`.
- **Outcome** lives on the `MeetingItem` (`outcome`, API:
  `outcome`). It is the only persisted per-item state.

```ts
type MeetingItemOutcome =
  | "not_discussed"
  | "done"
  | "follow_up"
```

`"discussing"` is **not** an outcome. It exists only as legacy
history (former item status) and must not be introduced as
canonical behavior.

Canonical semantics:

- **Changing current never mutates any outcome, and resolving an
  outcome never implicitly changes current except via the
  documented advance rule.**
- **Focus / make-current** (`POST /api/meeting-items/{id}/focus`)
  is Live-only navigation. It accepts an item of **any** outcome
  and changes only `currentMeetingItemId`; it never completes or
  reopens the previously current item.
- **Done / Follow-up** (`POST /api/meeting-items/{id}/done`,
  `POST /api/meeting-items/{id}/follow-up`) are Live-only
  explicit outcome mutations and do **not** require the target to
  be current. A previously `done` item may later become
  `follow_up` explicitly (and vice versa). When the resolved item
  **is** the current item, current advances to the next
  `not_discussed` item **after** the resolved item in canonical
  agenda order (`Section.position`, then `MeetingItem.position`,
  spanning section boundaries), wrapping once to the beginning if
  no open item exists after it. `done` / `follow_up` items are
  never selected as current by the advance rule, and the resolved
  item is never reselected; when no `not_discussed` items remain,
  current becomes `null`. When the resolved item is **not**
  current, current stays unchanged.
- **Start** (`upcoming -> live`) sets current to the first
  `not_discussed` item in canonical agenda order **only if no
  valid current item exists** (an already-set, still-valid
  pointer is preserved; a Meeting without items goes Live with no
  current item). Starting never mutates any outcome.
- **End** (`live -> completed`) is never blocked by the current
  pointer: remaining `not_discussed` items are allowed, and End
  clears `currentMeetingItemId`. End never mutates any outcome.
- **Reopen** (`completed -> live`) preserves `started_at`, clears
  `ended_at`, and — only if current is `null` and `not_discussed`
  items remain — sets current to the first of them. Reopen never
  mutates any outcome.
- **A newly created item** (including a spontaneous item) gets
  outcome `not_discussed` and does **not** automatically become
  current.
- **Deleting the current item** clears the pointer
  (`SET_NULL`), leaving the Meeting without a current item.

Outcome mutations only happen through the explicit domain actions
(`focus`, `done`, `follow-up`); the generic MeetingItem PATCH
rejects both the new `outcome` field and the legacy `status`
field.

Legacy data migrations (historical background; superseded by
0011): 0009/0010 mapped the former statuses
`open -> not_discussed`, `discussed -> done` (and introduced
`not_discussed`/`discussing`/`done`/`follow_up`). Migration 0011
removed the `status` column and introduced `outcome` plus the
persisted current pointer, mapping every legacy `discussing` row
to: the Meeting's `current_meeting_item` (the first such item per
Meeting) and outcome `not_discussed`; `done` / `follow_up` /
`not_discussed` rows kept their value. The old
discussing-only conditional unique constraint was removed.

### Intended but not yet implemented

The following `MeetingItem` capabilities remain intended direction and are not
in the current model:

- optional `intent` (`inform / discuss / decide`),
- `origin` (`planned / spontaneous`),
- `decision_markdown`,
- a linked `Topic`,
- durable follow-up carry-forward (the `follow_up` status exists;
  carry-forward is not yet an action).

Creating an item requires only a title (plus its Section).

---

## 18. Follow-up and carry-forward

`follow_up` means:

> This Meeting occurrence is finished for the item, but the subject needs future attention.

A follow-up does not necessarily create a Work Item.

However, it must have a durable continuation point.

If no Topic exists yet, the product should create/confirm a Topic before durable carry-forward.

Example:

```text
Topic A
├ MeetingItem Weekly 13 Aug
├ MeetingItem Weekly 20 Aug
└ MeetingItem Weekly 27 Aug
```

Each MeetingItem remains a stable historical snapshot.

### Carry-forward is an action, not a parallel status system

The user may choose:

```text
Carry forward
```

This means:

1. current item is closed as `follow_up`,
2. Topic remains open,
3. the Topic is suggested/materialized for the next relevant Meeting.

Do not introduce a separate meeting-specific task state.

---

## 19. Agenda materialization

A Meeting agenda is materialized.

It is not dynamically recomputed from all open Topics every time it renders.

This allows the agenda to be:

- prepared,
- reordered,
- extended,
- annotated,
- adjusted for a specific occurrence

without mutating previous Meetings or changing whenever Topic data changes.

---

## 20. Agenda order

Use simple integer ordering.

```text
position = 10, 20, 30 ...
```

or re-index affected items after drag-and-drop.

Do not introduce fractional ranking or collaborative sequence CRDTs until real scale/concurrency requires them.

---

## 21. Before the Meeting — Preparation experience

The preparation screen should answer:

1. What is planned?
2. What from previous Meetings may still need attention?
3. What information can be consumed asynchronously?
4. What do participants want to add?

### Example

```text
FG Weekly · Thu 27 Aug
Moderator: Chris

Add your topics before the meeting

FYIs
────────────────────────────────────
Cluster maintenance                 INFORM
Alex
✓ Read by 4/5

+ Add item


TOPs
────────────────────────────────────
GPU procurement                     DECIDE
Chris

Paper submission                    DISCUSS
Leon

+ Add item


Projects
────────────────────────────────────
Paper XYZ                           DISCUSS
Alex

+ Add item


Continue from previous meetings
────────────────────────────────────
Sample holder issue
Last discussed Aug 20
Linked work: ⊘ Replace holder · Chris · Blocked

[Add to agenda] [Not this week] [Resolve topic]
```

---

## 22. Participant input before the Meeting

Participants should be able to contribute agenda items before the Meeting.

The fastest path:

```text
+ Add item

What should we discuss?
[ GPU procurement ]

Add
```

Optional details may be added after creation:

- intent,
- context,
- linked Topic,
- linked Work Item when permitted.

### UX requirement

A useful agenda item must be creatable with a title alone.

No modal with seven required properties.

This supports parallel idea capture and reduces the moderator as the sole agenda bottleneck.

---

## 23. Asynchronous path for `inform`

Synchronous time should not be spent re-reading information everybody already consumed.

For `intent = inform`, participants may acknowledge the item before the Meeting.

Conceptual model:

```text
MeetingItemAcknowledgement

meeting_item_id
user_id
acknowledged_at
```

UI:

```text
Cluster maintenance
INFORM

✓ Mark as read
```

Aggregate display may show:

```text
Read by 5/5
```

If sufficiently acknowledged, the moderator may skip it during the live flow.

This is not a notification system and must not evolve into attendance/performance analytics.

---

## 24. Pre-Meeting continuity brief

Before a recurring Meeting, surface relevant unresolved context.

The system should **suggest**, not blindly duplicate.

Examples:

```text
From previous meetings

GPU procurement
Last decision:
Request second quotation.

Linked work:
✓ Review quotation · Done

Topic:
Still open

[Add to agenda] [Resolve]
```

and:

```text
Sample holder issue
Linked work:
⊘ Replace sample holder · Blocked

[Add to agenda] [Not this week]
```

The system performs memory support.

The human retains prioritization authority.

---

## 25. Live Meeting — Current Item mode

The live UX should be dominated by the currently discussed MeetingItem.

Do not show the whole database with equal visual weight.

Example:

```text
FG Weekly                                      24 min
3 of 8

GPU procurement                                DECIDE
────────────────────────────────────────────────────

Previous context
Last discussed Aug 20
Decision: Request another quotation
Linked work: ✓ Review quotation


Notes

Alex
Quotation B is significantly cheaper.

Chris
Performance difference is negligible.

+ Add note


Decision
Use quotation B.


Follow-up
+ Create work item


Done        Follow up        Carry forward
```

Secondary context such as the full agenda remains available but visually subordinate.

---

## 26. High-frequency interaction budget

The live Meeting competes with an ongoing human conversation.

Target interaction budgets:

| Action | Target |
|---|---:|
| Mark current item done | 1 action |
| Open Work Item detail | 1 action, 0 navigation |
| Add short note | focus + type + submit |
| Create spontaneous item | ≤2 interactions |
| Create Task from current item | ≤3 primary interactions |
| Record decision | directly in current item |
| Move to next agenda item | 1 action |
| Inspect prior context | 0 navigation |
| Create/link Work Item | 0 page navigation |

The exact timings are Living-Lab hypotheses, not universal laws.

---

## 27. Keyboard-first live UX

The moderator should be able to stay on the keyboard.

Recommended MVP shortcuts, only where they do not conflict with text editing:

```text
Ctrl/Cmd + Enter   submit current note / quick create where context makes sense
Esc                close transient UI / cancel active inline edit
```

Potential later shortcuts:

```text
N                  new spontaneous item
J / K              next / previous agenda item
```

Do not ship global shortcuts that hijack ordinary text-editor behavior.

---

## 28. Rich text / Markdown

Reuse the same editor core already planned for Work Item Description and Comments.

### MeetingItem context / decision

Use a compact Markdown-capable editor.

Supported MVP subset:

- paragraphs,
- bold,
- italic,
- inline code,
- links,
- bullet lists,
- numbered lists,
- checklists,
- Markdown shortcuts,
- `Ctrl/Cmd+B`,
- `Ctrl/Cmd+I`,
- `Ctrl/Cmd+K`.

### Notes

Each NoteEntry uses the compact editor.

No permanent Word-style toolbar.

Use:

- Markdown shortcuts,
- contextual bubble toolbar,
- subtle `/ commands` discoverability if the shared editor supports it.

Storage should use the canonical text format chosen for the shared editor, preferably Markdown while the supported feature set remains representable in Markdown.

---

## 29. Notes are an append-oriented entry stream

Do not store Meeting notes as one shared mutable text blob.

Conceptual model:

```text
MeetingNoteEntry

id
meeting_item_id
author_user_id
content_markdown
created_at
updated_at
```

Example:

```text
Alex
Quotation B is substantially cheaper.

Chris
Performance difference appears negligible.

Leon
Procurement requires the updated form.
```

Benefits:

- multiple people can contribute without editing the same text blob,
- attribution is explicit,
- concurrent additions do not overwrite one another,
- the existing comment/editor UX can be reused,
- no WebSockets are required for safe basic capture.

The read-only protocol may render entries as a coherent note stream.

---

## 30. Concurrency without realtime infrastructure

Realtime collaboration and WebSockets are not MVP requirements.

However, participant contributions must not silently disappear.

Use a lightweight strategy such as:

- polling the Meeting/agenda state while a Meeting is open,
- refetch on window focus,
- append-only NoteEntries,
- optimistic updates for the author,
- visible “new items available” signal when remote agenda changes arrive.

Example:

```text
3 new agenda updates
Refresh
```

or merge safe append-only changes automatically.

For single-value shared fields such as `decision_markdown`, use server-side update protection/version checking or restrict final decision confirmation to the moderator to avoid silent last-write-wins loss.

---

## 31. Spontaneous capture and Parking Lot

Spontaneous capture is valuable because an unrelated thought should not force a context switch in the active discussion.

MVP requirement:

```text
+ Add spontaneous item
```

The item receives:

```text
origin = spontaneous
```

and can be assigned to an existing Section.

### Optional low-cost enhancement: Parking Lot

If implementation remains small, a temporary Parking Lot may capture items without interrupting the current agenda.

```text
Parking lot · 2

• Check storage quota
• Discuss conference deadline
```

At close:

```text
[Add to agenda later] [Resolve] [Dismiss]
```

Parking Lot is useful but not foundational. It must not delay the core Meeting loop.

---

## 32. Decision

`notes` and `decision` are separate information.

Do not hide a decision inside free-form notes.

```text
MeetingItem.decision_markdown
```

The UI should make decision capture explicit for `intent = decide`, while still allowing a decision on any MeetingItem if needed.

Example:

```text
Decision
Use quotation B.
```

A decision remains historical even if the Topic later changes.

---

## 32a. Meeting Note (implemented)

A **Meeting Note** is a small, persistent discussion/protocol entry attached
to exactly one `MeetingItem`. It is *not* a Work Item.

### Canonical rule: Meeting Note != Work Item

```text
Meeting Note  ->  discussion / protocol context associated with a MeetingItem.
Work Item     ->  canonical Project work (Project Board, My Work, etc.).
```

A Meeting Note never has a Project, status, or assignment. A separate
`MeetingItem -> WorkItem` relation (Sections 33/34) is the only link to
durable project work. A Note may have exactly one **primary** WorkItem
created from it (MVP), recorded on that same relation (Section 34).

### Model

```text
MeetingNote
- id
- meeting_item   (exactly one owner; CASCADE on deletion)
- author         (FK to the authenticated user; RESTRICT; not client-set)
- content        (non-empty after strip)
- created_at
- updated_at
```

### Invariants

- A Note belongs to exactly one `MeetingItem`.
- The author is derived from the authenticated request; the client cannot
  spoof it.
- Empty / whitespace-only content is rejected.
- Ordering is deterministic (`created_at`, `id`).
- Deleting a `MeetingItem` or its `Meeting` removes owned Notes (CASCADE).
- Deleting a Note removes only the Note: the `MeetingItem`, the `Meeting`,
  and any linked Work Items are untouched.
- Deleting a Note whose primary WorkItem exists removes only the Note and
  the link row; the WorkItem is untouched (and vice versa: deleting the
  WorkItem leaves the Note).
- Notes are occurrence-specific: a Note belongs to the concrete Meeting
  occurrence, never to the Meeting Template.

### Lifecycle visibility

```text
Upcoming   ->  no Note authoring; no Add note controls.
Live       ->  persisted Notes visible; Add / Edit / Delete by write users.
Completed  ->  persisted Notes visible under their original Agenda Item as
               read-only protocol; no Add / Edit / Delete controls.
```

A Completed Meeting's Notes must survive a page reload.

### Creating work from a Note (implemented)

The live composer's `Create work item` action first **persists the
Note**. Only if persistence succeeds does the Work Item creation UI open,
anchored to that exact persisted Note; on failure the draft is preserved
and no (unpersisted) source relation is implied. The inline composer and
the Work Item creation UI are never open simultaneously.

A persisted Note without a primary WorkItem offers a quiet contextual
`Create work item` that operates on **only that Note** — never on all
Notes of the Agenda Item and never on `contextNotes`. This remains
available for an unlinked Note of a Completed Meeting when the current
user can write the Meeting's scope; the action never edits the Note.

Once a Note has its primary WorkItem, the `Create work item` action for
that Note disappears and is replaced by the **Linked work**
representation rendered directly at the source Note (calm, contextual,
canonical data: title, Project, assignees, status). Clicking it opens the
existing Work Item Inspector in place — no navigation, Meeting context
preserved.

**One primary WorkItem per Note (MVP).** Uniqueness is enforced by the
database (unique constraint on the link) and re-checked in the creation
transaction, so repeated or concurrent requests cannot create a second
primary WorkItem for the same Note. "+ Add another work item" is not part
of the MVP.

### Authoring authorization

Note authoring reuses the canonical Meeting write model (Research Group
admin for group Meetings; Project owner/member for Project Meetings). The
server enforces this independently of frontend visibility, and Upcoming or
Completed Meetings reject Note create / update / delete.

### API

```text
GET    /api/meeting-items/{id}/notes/      list Notes (deterministic order)
POST   /api/meeting-items/{id}/notes/      create Note
PATCH  /api/meeting-notes/{id}/            update Note content
DELETE /api/meeting-notes/{id}/            delete Note
```

Notes are also embedded in `GET /api/meetings/{id}/items/` (each item's
`notes` array) so the Meeting Detail page does not N+1 load them.

---

## 33. Meeting → Work Item (implemented)

A Work Item created from a Meeting is **canonical Project work** — the same object shown in the Project Board, Project List, and My Work. A Meeting is not an alternative Work Item store.

Creation works from a MeetingItem (the agenda flow) or from the exact
persisted MeetingNote of that item (the Note flow, Section 32a). Both use
the same canonical Work Item service and the same target-Project rules.

Central flow:
```text
MeetingItem
    ↓
Create Work Item
    ↓
Project
    ↓
Task / default type
    ↓
Assignee
    ↓
Due date optional
    ↓
Create
```

### Prefill from the exact Note

Description is the full MeetingNote content. Title is a deterministic,
concise suggestion (first meaningful line, capped); no LLM or external
API. The user may edit every field before creation.

### Project selection

- **Project Meeting**: the Meeting's Project is preselected when it is
  writable by the current user.
- **Research Group Meeting**: NO Project is silently preselected; the
  Project starts unselected and the user must explicitly choose one.
- Only Projects where the current user may create Work Items
  (owner/member, not archived) are offered.
- Changing the Project reloads its Type/Status/Label definitions and
  clears selections that are invalid in the new Project; canonical
  defaults (e.g. the Project's default Status) apply only where the
  domain defines them.
- The server validates every submitted Definition ID against the selected
  Project (same-Project configuration invariant); frontend validation is
  not authoritative.

### Live Quick Create

The Meeting version of Work Item creation should be faster than the full Project Create flow.

Example in a Research Group Meeting:

```text
New task

What needs to be done?
[ Prepare purchase request ]

Project
[ Procurement ▾ ]

Assignee
[ Chris ▾ ]

Create
```

Description, Parent, advanced status/type configuration and other properties belong behind “More” or can be added later.

### Target Project is required

The target Project is required when creating a Work Item from a Meeting. The Work Item's type, status, and label definitions come from **that** Project's configuration (referenced by definition ID).

Rules (enforced server-side):

- The target Project must belong to the same Research Group as the Meeting.
- A Project Meeting may only create work inside its own Project (`project_id`); the Project is not re-requested.
- A Research Group Meeting requires the caller to select a target Project.

### Task default

If the current Project has a clear default Task type, use it and hide the type picker in the live quick-create path.

Do not invent a type mapping if the Project configuration cannot provide one.

---

## 34. Work Item origin (implemented)

Creating a Work Item from a MeetingItem records the origin in a
`MeetingItemWorkItem` link table. When the Work Item was created from a
persisted MeetingNote, the same link also records that exact Note:

```text
MeetingItemWorkItem

meeting_item_id
work_item_id
meeting_note_id      (nullable)
created_by_id
created_at
```

Constraint: `UNIQUE(meeting_item_id, work_item_id)`.
Constraint: `UNIQUE(meeting_note_id)` — one primary WorkItem per Note.

Meaning:

> This Work Item was created from this concrete MeetingItem.
> When `meeting_note_id` is set: this Work Item is the primary WorkItem
> of this concrete MeetingNote (Meeting → MeetingItem → MeetingNote →
> WorkItem).

This relation is historical provenance.

The Work Item detail/list API exposes the resolved source as
`meetingOrigin` (Meeting, Agenda item title, source Note content) to
users who can read that Meeting, and the Meeting items list exposes the
Note's primary WorkItem as `linkedWorkItem` to users who can read its
Project. Neither field leaks objects across those boundaries.
---

## 35. Later Work Item discussions

> **Not yet implemented.** A separate `WorkItemDiscussion` relation (distinct from the origin link) is intended direction, not current behavior. Currently, a `MeetingItemWorkItem` link records the origin.

An existing Work Item may be discussed in later Meetings.

Origin and later discussion are distinct relations.

```text
WorkItemDiscussion

work_item_id
meeting_item_id
```

Example:

```text
Weekly 1 → Work Item created
Weekly 3 → same Work Item discussed again
```

Then:

```text
source = Weekly 1 MeetingItem
discussion = Weekly 3 MeetingItem
```

This supports traceability without duplicating the Work Item.

---

## 36. Work Item Inspector inside the Meeting

Clicking linked work opens the existing right-side Work Item Inspector.

Do not navigate away.

```text
Meeting context                      Work Item Inspector
──────────────────                   ────────────────────
GPU procurement                      Prepare purchase request

Decision                             Description
...                                  ...

Linked work                          Status
□ Prepare request   ─────────────→   Assignee
                                     Due
```

The underlying Work Item is live canonical data.

If its status changes in Project Board/My Work, the Meeting projection reflects the current state.

Historical origin remains unchanged.

---

## 37. Project isolation in Meetings

This is security-critical.

### Research Group Meeting

Referencing a private Project object does not make that object visible to Research Group members without Project access.

A Research Group Meeting must not automatically expose private:

- Project details,
- Project Topics,
- Work Items,
- Project decisions,
- Project Meeting history.

The server enforces this boundary.

### Explicit group-level Project update

A participant may write group-level text such as:

```text
Paper submission is planned for September.
```

That text is Meeting content and can be visible to the group.

It must not cause the system to fetch and reveal private Project internals.

### Permission-aware linked Work Item rendering

For authorized users:

```text
□ Rewrite methods section
Paper XYZ · Chris
```

For unauthorized users, product policy must define either:

```text
Private project work
```

or no link/object rendering at all.

Do not leak titles, assignees, descriptions, statuses or Project names unless the user is authorized to see them.

---

## 38. Meeting lifecycle (implemented)

A Meeting moves through three statuses with explicit server-side actions.
Transitions are guarded and serialized (each action takes a row lock on the
Meeting and re-checks the current status).

```text
upcoming  →  live  →  completed
             ↑  (reopen)
```

### Start

`upcoming → live` — `started_at = now` (server time).

### End

`live → completed` — `ended_at = now` (server time).
Only a live Meeting can be ended.

### Reopen

`completed → live` — preserves the original `started_at` and clears
`ended_at`. Only a completed Meeting can be reopened. Ending the reopened
Meeting records a new `ended_at`.

### What is and is not enforced

- The implemented lifecycle is **only** the upcoming/live/completed state
  machine above. Ending a Meeting is **not** blocked by the current
  pointer: remaining `not_discussed` items are allowed, and End clears
  `currentMeetingItemId` (see Section 17).
- The richer live-meeting ceremony from the product concept (Agenda |
  Current Item split UI, moderator and moderator rotation, frontend-local
  **Selected** free navigation of the agenda rail, per-item `intent` and
  `origin`) is not implemented.

---

## 39. Stale live Meetings

Do not automatically claim a Meeting was completed when nobody actually ended it.

If a Meeting remains `live` far beyond its scheduled time, treat “stale” as derived UI state.

On next open:

```text
This meeting still appears to be open.

[End meeting] [Keep open]
```

If the user ends it later, record the actual confirmation time and preserve scheduled times separately.

This is preferable to silently creating false historical completion.

---

## 40. Post-meeting editing

A completed Meeting is not immutable.

Users may still:

- append missing notes,
- correct obvious text errors,
- add omitted context,
- link a Work Item that was forgotten.

Where a historical meaning could change, show a simple timestamp such as:

```text
Edited after meeting
```

Do not build a full audit platform for MVP.

Destructive or meaning-changing edits to decisions should be handled conservatively.

---

## 41. Closure step

Ending a Meeting should include a short verification step.

Example:

```text
End FG Weekly
────────────────────────────────

Decisions · 2

✓ Use quotation B
✓ Submission remains Sep 30


Created work · 3

□ Prepare purchase request      Chris
□ Update introduction           Alex
□ Check dataset                 Leon


Follow-up · 2

↻ Conference planning
↻ Sample holder issue


Undiscussed · 1

○ Tech News


Next moderator

Chris


Back                      End meeting
```

The goal is:

> “Is anything missing?”

not:

> “Write a formal protocol now.”

---

## 42. Protocol is a projection, not a second document

The Meeting protocol must be generated from canonical Meeting data.

It is not a separately maintained Word-like document.

Projection example:

```text
FG Weekly · 27 Aug 2026

Moderator
Chris

Participants
Alex · Chris · Leon · Raffaella


FYIs

Cluster maintenance
...


TOPs

GPU procurement

Notes
...

Decision
Use quotation B.

Resulting work
□ Prepare purchase request · Chris


Projects
...


KVP
...


Next moderator
Leon
```

The protocol reads like a document but is backed by structured Meeting data.

---

## 43. Decision Log

A Decision Log is a projection, not a new domain.

Group-level:

```text
Decisions

27 Aug · FG Weekly
Use quotation B.

20 Aug · FG Weekly
Submission remains Sep 30.
```

Project-level:

```text
Paper XYZ decisions
...
```

Clicking a decision opens its source MeetingItem.

Where linked Work Items exist, their current state may be shown.

This supports long-term traceability:

> What did we decide, when, why, and what happened afterward?

No full-text-search infrastructure is required for the first version.

---

## 44. Continuity into the next Meeting

The next recurring Meeting should not simply copy the old protocol.

It should surface relevant context.

Example:

```text
Continue from previous meetings

GPU procurement
Decision: Use quotation B
Linked work: ◐ Prepare purchase request · In progress
Topic: open

[Add to agenda] [Resolve]


Conference planning
Carried forward last meeting

[Add to agenda] [Not this week]
```

This is the core continuity loop.

---

## 45. Research Group Weekly seed

The current FG Weekly structure is an initial seed, not hardcoded product behavior.

Suggested initial Sections:

```text
Check-In
FYIs
TOPs
Projekte
Akquise
Lehre
Paper
Forschungsgruppe
Tech-News
Fails & Highlights
KVP
```

The (not-yet-implemented) Template guidance would contain the current “Spielregeln”.

Moderator rotation contains the current member order.

“Next moderator” is generated from the rotation rather than manually maintained as normal agenda content.

Participants are structured instead of a free-text “Anwesend” line, subject to governance/privacy decisions before real deployment.

---

## 46. Mapping the current Word structure

| Current Word concept | FG Workspace concept |
|---|---|
| Spielregeln | MeetingSeries guidance |
| Moderationsreihenfolge | Moderator rotation |
| Teamsitzungsprotokoll + Datum | Meeting occurrence |
| Anwesend | MeetingParticipants |
| Protokoll | generated read projection |
| Check-In: Learnings | Section |
| FYIs | Section + MeetingItems |
| TOPs | Section + MeetingItems |
| Beschreibung/Ergebnisse | MeetingItem context + NoteEntries + Decision |
| Projekte | Section |
| Akquise | Section |
| Lehre | Section |
| Paper | Section |
| Forschungsgruppe | Section |
| Tech-News | Section |
| Fails & Highlights | Section, with explicit persistence/privacy decision |
| KVP | Section |
| Nächste Moderation | system projection from moderator rotation |

---

## 47. Socially sensitive sections

Digitization changes the social meaning of some rituals.

A spoken “Fail of the week” in a transient meeting is not equivalent to storing an attributable database record for years.

Before real-group deployment, explicitly decide how sections such as `Fails & Highlights` should persist.

A low-complexity extension may support:

```ts
type SectionPersistence =
  | "persistent"
  | "live_only"
```

or an equivalent policy.

Do not introduce this merely for theoretical flexibility; introduce it when the real Weekly’s social practice requires it.

Until that decision is made, do not silently make sensitive contributions permanently attributable.

---

## 48. Attendance, attribution and governance

Structured Meeting data can include:

- participation,
- moderator history,
- authored notes,
- decisions,
- acknowledgements,
- Work Item ownership.

This can create governance, privacy and employee-representation concerns depending on institutional context.

Before real research-group deployment:

- clarify hosting and access,
- clarify retention/deletion,
- clarify whether structured attendance is needed,
- clarify whether sensitive rituals should be persisted,
- clarify institutional data-protection and staff-representation requirements.

The MVP must not add:

- attendance scores,
- speaking-time analytics,
- participation rankings,
- performance inference,
- “engagement” scoring.

---

## 49. UX architecture

Recommended Series-level navigation:

```text
FG Weekly

Overview     Meetings     Structure     Settings
```

### Overview

Shows:

- purpose,
- next Meeting,
- moderator,
- agenda count,
- open/relevant Topics,
- latest/important decisions.

### Meetings

Shows:

```text
Upcoming

27 Aug   Chris   7 items


Past

20 Aug   Alex    Completed
13 Aug   Olli    Completed
```

### Structure

Simple Section editor:

```text
≡ Check-In
≡ FYIs
≡ TOPs
≡ Projekte
...
+ Add section
```

No schema builder.

### Settings

Shows:

- Series name,
- purpose,
- guidance,
- default participants,
- moderator rotation,
- archive/delete.

---

## 50. Meeting UI modes

A Meeting has three major UI states.

### Preparation

Agenda-centric.

Users add, reorder and acknowledge items.

### Live

Current-item-centric.

The active discussion dominates.

### Completed

Protocol/history-centric.

The Meeting reads primarily as a record, with controlled post-meeting edits.

Do not force three separate page architectures if one adaptive Meeting surface can switch modes cleanly.

---

## 51. Visual/interaction principles

The Meeting UI should follow the same FG Workspace design language as Work Items:

- few containers,
- restrained color,
- clear hierarchy,
- content first,
- exceptions and active state receive visual emphasis,
- secondary metadata is subdued,
- no dashboard-like badge explosion,
- no permanent Word-style toolbar,
- no full-page navigation for contextual edits,
- inline/detail editing where safe,
- right-side Inspector for Work Items.

During live Meetings, the strongest visual element is the current MeetingItem.

---

## 52. Accessibility

Minimum requirements:

- every MeetingItem is keyboard focusable,
- active item has semantic state in addition to color,
- status/intent is never color-only,
- buttons have accessible names,
- agenda ordering has a non-drag alternative,
- Work Item quick-create is keyboard operable,
- rich-text controls are reachable and labelled,
- protocol remains readable without graph/visual-only semantics,
- focus returns sensibly when drawers/popovers close.

If drag-and-drop is used for agenda ordering, also provide keyboard/menu actions such as:

```text
Move up
Move down
Move to section…
```

---

## 53. Responsive behavior

### Desktop

- full agenda/preparation layout,
- live current-item workspace,
- Work Item Inspector as non-modal right-side panel.

### Tablet

- condensed agenda rail,
- Inspector may overlay part of the surface,
- no unnecessary background dimming unless a truly modal action is used.

### Mobile

- single-column Meeting flow,
- current item first,
- agenda accessible as a secondary sheet/list,
- Work Item detail may use full-screen detail mode.

---

## 54. Server-side invariants (implemented)

1. A Research Group Meeting has no `project_id` (scope `group`).
2. A Project Meeting has a `project_id` (scope `project`).
3. Both `Meeting` and `MeetingSeries` enforce the scope/project consistency constraint at the database level.
4. Research Group Meeting participants must be members of the Meeting's Research Group.
5. Project Meeting participants must have read access to the Meeting's Project.
6. Meeting content on a Project Meeting obeys Project write roles: `viewer` cannot mutate; archived Projects are read-only.
7. Every `MeetingItem` belongs to exactly one `Meeting`.
8. Every `MeetingItem` belongs to exactly one `MeetingSection` (`meeting_section` is NOT NULL).
9. Historical `MeetingSection` labels do not change when the Template structure is later edited (occurrence is a snapshot).
10. Editing an occurrence never mutates its Template.
11. A Meeting created without a Template still has a real default `Agenda` Section.
12. Meeting → Work Item creation always requires a target Project.
13. A Project Meeting can only create work in its own Project.
14. Meeting → Work Item creation obeys Project write permissions, assignee eligibility, and Work Item invariants (the Work Item service remains authoritative).
15. Meeting/MeetingItem queries are permission-filtered and must not leak inaccessible Project data.
16. Meeting lifecycle transitions (start/end/reopen) are guarded and serialized per Meeting.

> Intended invariants that depend on not-yet-implemented concepts (Topic
> state, per-item `intent`/`origin`, NoteEntry streams, moderator rotation,
> frontend-local Selected navigation) are described in the relevant sections
> and are not current guarantees.

---

## 55. Data model (implemented)

```text
ResearchGroup
│
├── MeetingSeries   (a Meeting Template)
│   ├── MeetingSeriesSection[]   (template structure)
│   └── Meeting[]                (occurrences)
│       ├── MeetingParticipant[]
│       ├── MeetingSection[]     (occurrence structure / snapshot)
│       │   └── MeetingItem[]
│       │       └── MeetingItemWorkItem[]   (origin link to canonical WorkItem)
│       └── (standalone meeting: one default "Agenda" section)
```

Not yet persisted: `DefaultParticipant`, `ModeratorRotation`, `Topic`,
`MeetingNoteEntry`, `MeetingItemAcknowledgement`, `decision_markdown`, and a
separate Work Item discussion link. Those are intended direction.

---

## 56. Recommended API capability shape

Exact endpoints may follow existing repository conventions, but the frontend needs capabilities equivalent to:

```text
Meeting Series
GET    list/detail
POST   create
PATCH  edit
DELETE/archive

Series Sections
POST   add
PATCH  rename/edit/reorder
DELETE/deactivate

Meetings
GET    list/detail
POST   create occurrence
PATCH  edit occurrence/start/end

Meeting Participants
GET
POST/add
DELETE/remove

Meeting Sections
PATCH  reorder/hide/rename
POST   add one-off section

Meeting Items
POST   create
PATCH  edit/intent/status/order
DELETE where allowed

Note Entries
POST
PATCH own entry
DELETE own entry where allowed

Acknowledgements
POST/DELETE current user's acknowledgement

Topics
GET
POST
PATCH resolve/reopen/defer metadata

Meeting → Work Item
POST create canonical Work Item from MeetingItem

Work Item discussion
POST link existing Work Item to MeetingItem
DELETE unlink where allowed

Decision Log
GET projection/filter by scope/series/project
```

Do not create API endpoints that mirror UI components instead of domain behavior.

---

## 57. Lightweight refresh strategy

Because WebSockets are not MVP scope:

- active Meeting screens refetch/poll relevant lightweight state,
- refetch on focus,
- mutations update local state optimistically,
- append-only notes merge naturally,
- remote agenda additions surface visibly,
- stale shared-field edits are rejected or resolved deliberately.

The product must never silently overwrite a second user’s note contribution.

---

## 58. Failure and recovery behavior

### Network failure while adding note

Keep local draft and show retry.

### Network failure while creating Work Item

Do not show a successful follow-up link until the canonical Work Item exists.

### Closing browser with draft

Preserve local editor draft if feasible.

### Stale Meeting open

Prompt to close/continue.

### Completed Meeting edited later

Allow legitimate correction/addition; indicate post-meeting edit where relevant.

### Linked private Project access removed later

Historical Meeting content continues to obey current authorization for live Project object rendering.

Do not cache protected object details into a group-visible protocol.

---

## 59. MVP scope

### Required

- MeetingSeries
- editable Series metadata
- simple editable Series Sections
- simple Structure view
- copy structure from existing Series
- concrete Meeting occurrences
- occurrence-level editing
- MeetingSection snapshot
- default participants + occurrence participants
- moderator + moderator rotation
- Topic
- MeetingItem
- optional `inform / discuss / decide`
- `planned / spontaneous`
- pre-meeting participant agenda input
- agenda ordering
- lightweight continuity brief
- Topic resolve/defer handling
- `inform` acknowledgement
- live current-item mode
- NoteEntry stream
- explicit Decision
- Work Item quick create
- Work Item origin
- later Work Item discussion link
- follow-up / carry-forward
- closure summary
- protocol projection
- Decision Log projection
- permission-aware Group vs Project Meetings
- stale/live recovery
- post-meeting editing
- lightweight polling/refetch strategy
- accessibility basics

### Optional if low-cost and does not delay core

- Parking Lot
- meeting-specific one-off Sections
- aggregate “Read by x/y”
- local drafts per MeetingItem
- simple “edited after meeting” marker

---

## 60. Explicit non-goals for MVP

Do not implement before validated need:

- AI summarization,
- AI action-item extraction,
- transcription,
- recording,
- calendar-provider integration,
- scheduling polls,
- WebSockets,
- realtime rich-text co-editing,
- generic RBAC,
- generic workflow engine,
- Custom Fields for Sections,
- generic meeting schema builder,
- section-specific state machines,
- configurable contribution rule engine,
- meeting analytics platform,
- speaking-time analytics,
- attendance analytics,
- recommendation engine,
- automatic agenda prioritization,
- template marketplace,
- full audit platform,
- full-text search infrastructure.

---

## 61. Suggested implementation order

### Phase M0 — Preconditions

Do not start until the Core acceptance flow is reliable end-to-end:

```text
Project isolation
Work Item persistence
Assignment
My Work
Same canonical Work Item across views
```

### Phase M1 — Meeting skeleton

Implement:

- MeetingSeries,
- Series Sections,
- Series edit UI,
- Meeting occurrence,
- MeetingSection snapshot,
- participants,
- moderator,
- moderator rotation,
- upcoming/live/completed lifecycle.

### Phase M2 — Agenda and Topics

Implement:

- Topics,
- MeetingItems,
- participant pre-meeting input,
- intent/origin,
- ordering,
- open Topic suggestions,
- resolve/defer.

### Phase M3 — Live Meeting

Implement:

- current-item mode,
- NoteEntry stream,
- decision,
- done/follow-up,
- spontaneous item,
- refresh strategy.

### Phase M4 — Work integration

Implement:

- quick-create canonical Work Item,
- source_meeting_item_id,
- later WorkItemDiscussion,
- Work Item Inspector in Meeting,
- permission-aware rendering.

### Phase M5 — Close and continuity

Implement:

- closure summary,
- carry-forward,
- protocol projection,
- next-Meeting continuity brief,
- Decision Log,
- `inform` acknowledgements if not already built.

### Phase M6 — Living Lab refinement

Observe real Weekly use before adding generic abstractions.

---

## 62. Living-Lab hypotheses

Validate, do not assume:

1. Can participants add an agenda item without instruction?
2. Can the moderator understand what to do within five seconds?
3. Can a Work Item be created during conversation without losing the thread?
4. Do `inform / discuss / decide` help or feel redundant?
5. Does the continuity brief reduce manual reconstruction?
6. Does `inform` acknowledgement actually reduce live meeting time?
7. Are NoteEntries natural enough compared with one shared document?
8. Is moderator rotation useful in practice?
9. Do Topics become stale despite defer handling?
10. Does persistent capture change behavior in Fails & Highlights?
11. Does the close step catch missing decisions/follow-ups without becoming ceremony?
12. Can users distinguish Topic state, MeetingItem state and Work Item state?

Observed signals:

- task success,
- time,
- visible hesitation,
- misclicks,
- navigation count,
- abandonment,
- questions,
- requested workarounds,
- whether people revert to Word/paper/chat.

---

## 63. Acceptance flows

### A. Create/edit a Meeting Series

```text
Alex creates FG Weekly
→ adds/renames/reorders Sections
→ adds default participants
→ configures moderator rotation
→ creates next Meeting
→ Meeting receives the current structure
```

### B. Series change does not rewrite history

```text
Aug Meeting uses "Tech-News"
→ Series renames it to "Research & Tech"
→ Aug Meeting still reads "Tech-News"
→ next Meeting uses "Research & Tech"
```

### C. Participant contributes before Meeting

```text
Chris opens upcoming Weekly
→ adds "GPU procurement" under TOPs
→ title alone is sufficient
→ optionally selects Decide
→ moderator sees it without manual copy
```

### D. Live discussion creates work

```text
Moderator opens GPU procurement
→ notes discussion
→ records decision
→ creates Task for Chris
→ selects required Project
→ Task is created canonically
→ Task appears in Chris's My Work and Project Board
→ Meeting stays open at the same context
```

### E. Project Meeting quick create

```text
Project Meeting for Paper XYZ
→ create follow-up
→ Project is prefilled and not re-requested
→ valid Project member assigned
```

### F. Permission isolation

```text
Group Weekly references private Project work
→ authorized users see permitted linked object
→ unauthorized group members do not receive private Project details
```

### G. Topic continuity

```text
Topic discussed Aug 20
→ follow-up / Work Item created
→ Topic remains open
→ Aug 27 preparation surfaces previous decision + current Work Item state
→ moderator can add, defer or resolve
```

### H. Notes without destructive concurrency

```text
Alex adds NoteEntry
Chris adds NoteEntry
→ both persist independently
→ neither overwrites the other
```

### I. Forgotten end

```text
Meeting remains live after scheduled time
→ next open shows stale-live prompt
→ user explicitly ends or continues it
```

### J. Protocol

```text
Meeting completed
→ protocol shows participants, Sections, notes, decisions and linked work
→ no second task/document copy exists
```

---

## 64. Definition of Meeting MVP success

A Research Group member can reliably understand:

- which Meeting/Series they are in,
- who is moderating,
- what the agenda structure is,
- what is currently being discussed,
- what was previously discussed about the Topic,
- what was decided,
- whether follow-up is required,
- which canonical Work Item was created,
- which Project owns it,
- who is assigned,
- its current state,
- whether the same Topic was discussed again,
- which historical MeetingItems belong to the Topic,
- what should be reconsidered at the next Meeting.

The Meeting feature succeeds when the user no longer needs to manually reconcile:

```text
Word protocol
+ memory
+ separate task list
+ Project Board
```

to understand what happened and what happens next.

---

## 65. Research-informed UX rationale

These references support broad design directions, not the exact implementation.

### Agendas, pre/post communication and meeting effectiveness

Cutler et al. (CSCW 2021) found correlations between perceived meeting effectiveness/inclusiveness and factors including agenda use, pre-meeting communication and post-meeting summaries in a large organizational survey.

Design implication:

- preparation matters,
- agenda structure matters,
- post-meeting continuity matters.

Do not interpret the study as proof that this product's exact `inform/discuss/decide` model is optimal.

Primary/official source:

- Ross Cutler et al., *Meeting Effectiveness and Inclusiveness in Remote Collaboration*, PACM HCI 5 (CSCW1), 2021. DOI: https://doi.org/10.1145/3449247
- Microsoft Research: https://www.microsoft.com/en-us/research/publication/meeting-effectiveness-and-inclusiveness-in-remote-collaboration/

### Prospective memory and cognitive offloading

Research on intention offloading shows that people use external reminders to support delayed intentions, and reviews report substantial performance benefits in reminder-supported prospective-memory tasks.

Design implication:

- FG Workspace should externalize follow-up memory,
- the system should resurface cue + action + ownership at the point of relevance,
- users should not need to remember that “something from last week” still matters.

Reference:

- Gilbert, S. J. et al., review of intention offloading: https://pmc.ncbi.nlm.nih.gov/articles/PMC9971128/

### Interruptions and resumption costs

Task-interruption research reports measurable resumption costs and shows that interruption timing/context can affect the cost of returning to a task.

Design implication:

- do not navigate the moderator away from the Meeting for Work Item creation or inspection,
- preserve current item, focus and scroll position.

Reference:

- Hirsch et al. (2025), *Opportune moments for task interruptions*: https://pubmed.ncbi.nlm.nih.gov/39881699/

### Production blocking

Classic brainstorming research and later work describe production blocking: in interactive verbal groups, people cannot all contribute simultaneously and waiting can impair idea generation.

Design implication:

- allow participants to contribute agenda items before the Meeting,
- allow lightweight spontaneous capture without interrupting the active discussion.

Reference:

- Diehl & Stroebe (1987), *Productivity Loss in Brainstorming Groups: Toward the Solution of a Riddle*.

### Psychological safety

Edmondson's work defines team psychological safety around perceived interpersonal risk and links it with learning behavior in teams.

Design implication:

- digital persistence and attribution are socially meaningful,
- do not assume that digitizing sensitive rituals is neutral,
- validate persistence/attribution for “Fails & Highlights” and similar practices.

Reference:

- Edmondson, A. (1999), *Psychological Safety and Learning Behavior in Work Teams*. DOI: https://doi.org/10.2307/2666999

---

## 66. Product references and patterns

These are product inspirations, not research evidence.

### Fellow

Current Fellow documentation shows patterns including:

- collaborative agenda building before meetings,
- recurring meeting-note series,
- action items assigned during meetings,
- carry-forward of incomplete items,
- pre-meeting briefs,
- slash-command editing.

FG Workspace should borrow the useful interaction patterns but improve the work model:

> A follow-up should become/link the same canonical Project Work Item rather than a parallel meeting-action-item system that later needs integration/synchronization.

Official documentation examples:

- https://help.fellow.ai/en/articles/8619527-basics-of-a-fellow-meeting-note
- https://help.fellow.ai/en/articles/9773836-meeting-briefs
- https://help.fellow.ai/en/articles/3808993-set-templates-for-your-meetings

### Confluence / collaborative notes

Confluence demonstrates useful patterns around:

- structured meeting notes,
- action items,
- mentions,
- comments,
- collapsible supporting information.

FG Workspace should remain more structured around Topic history, decisions and canonical Work Items instead of becoming a general wiki/document system.

---

## 67. Final product rule

The Meeting system should be designed around one durable loop:

```text
PREPARE
People add what matters.
The system resurfaces what may have been forgotten.

LIVE
One current item dominates.
Notes, decision and follow-up happen without navigation.

WORK
Canonical Work Items live in Projects and My Work.

RETURN
The next Meeting receives the relevant current state,
not a copied old protocol.
```

The Meeting structure is editable enough to support real meeting rituals.

The platform is deliberately **not** generic enough to predict every future meeting style before a second real use case proves which dimensions need abstraction.

That boundary is part of the MVP design.
