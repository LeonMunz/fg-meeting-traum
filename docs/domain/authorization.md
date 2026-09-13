# FG Workspace — Membership & Authorization Domain

This document is the canonical domain reference for the ResearchGroup /
Project membership, scope, ownership, and authorization foundation.

Companion documents:

- `docs/domain/foundation.md` — Project/WorkItem domain semantics.
- `docs/domain/meetings.md` — Meeting domain semantics.
- `docs/architecture.md` — technical architecture (server-side, deny-by-default).

The invariants below are **settled product decisions**. Code that
contradicts this document is an implementation defect, not a product
ambiguity.

## 1. Identity

1. A User is a global identity. A User may belong to any number of
   ResearchGroups and Projects.
2. The authenticated identity is derived from the server session/request.
   A client-supplied user ID never establishes identity.
3. Authorization is always server-side and deny-by-default. UI visibility
   is never a security decision.

## 2. Scopes

ResearchGroup and Project are the two explicit resource scopes.

1. Every Project belongs to exactly one ResearchGroup (persistent,
   immutable reference).
2. A resource's scope is determined by its persisted relationships, not by
   the request:
   - a Project and all Project-owned resources (Work Items, Work Item
     configuration, Project Meetings, Project Meeting Series) are
     Project-scoped;
   - group-level resources (Research Group Meetings, group Meeting
     Series) are ResearchGroup-scoped.
3. Work Items and Meetings must use this same scope/authorization
   foundation. There is no screen-specific or endpoint-specific access
   truth.

## 3. Membership invariants

1. `ResearchGroupMembership` is unique per (ResearchGroup, User).
2. `ProjectMembership` is unique per (Project, User).
3. A valid `ProjectMembership` requires a valid `ResearchGroupMembership`
   in the Project's ResearchGroup. This is enforced by a database
   constraint (composite foreign key), not only by application logic.
4. ResearchGroup membership does not imply Project access.
5. Removing a `ProjectMembership` immediately removes future
   server-side access to that Project.
6. Removing a `ResearchGroupMembership` immediately removes future access
   to the group and all Projects in it, and revokes/removes the user's
   `ProjectMembership`s in that group. Project-owned resources of the
   affected Projects remain intact; only the user's memberships are
   removed.
7. A later ResearchGroup rejoin does not restore old
   `ProjectMembership`s.
8. The user/account state represented by the current system (an inactive
   account) grants no capabilities.

## 4. Ownership invariants

The ResearchGroup role `admin` is the group's **Owner** role. The Project
role `owner` is the Project's **Owner** role. Persisted role values are
not renamed for presentation terminology.

1. Every ResearchGroup has 1..n Owners (`admin` memberships).
2. Every active Project has 1..n Owners. (Archived, paused, or completed
   Projects may be ownerless; the invariant protects *active* Projects.)
3. The last Owner of an existing ResearchGroup or active Project cannot be
   removed, leave, be downgraded, or lose ownership through
   group-membership cleanup unless another Owner is established in the
   same atomic operation (explicit transfer) or, for the group-offboarding
   workflow, the Project is archived in the same transaction.
4. Ownership mutations are concurrency-safe: owner-set validation and
   mutation happen under a PostgreSQL row lock on the parent
   ResearchGroup/Project inside one transaction.
5. Every active account may create a ResearchGroup and becomes its first
   Owner atomically.
6. Every active ResearchGroup member may create a Project in that group
   and becomes its first Project Owner atomically.

## 5. Capabilities

Roles are centrally mapped to typed capabilities. There is exactly one
authorization foundation (the server-side authorization service); endpoint
code checks capabilities, never raw role strings.

### Capability inventory

| Capability | Meaning |
|---|---|
| `GROUP_READ` | Read group-level resources and the group directory |
| `GROUP_CREATE_PROJECT` | Create a Project in the group |
| `GROUP_MANAGE` | Manage group settings and group memberships (incl. offboarding) |
| `PROJECT_READ` | Read the Project and its private content (Work Items, configuration) |
| `PROJECT_WORK` | Create/edit/move Work Items, assign work, work on Project Meetings and Project Meeting Series |
| `PROJECT_MANAGE` | Manage Project memberships, Work Item configuration, and Project lifecycle (archive/restore/update/delete) |
| `MEETING_READ` | Read one Meeting occurrence and its content |
| `MEETING_WRITE` | Mutate a Meeting occurrence (lifecycle, sections, items, notes, participants) |
| `MEETING_SERIES_READ` | Read one Meeting Series template |
| `MEETING_SERIES_WRITE` | Mutate a Meeting Series template |

### ResearchGroup role → capabilities

| Capability | `member` | `admin` (group Owner) |
|---|---|---|
| `GROUP_READ` | yes | yes |
| `GROUP_CREATE_PROJECT` | yes | yes |
| `GROUP_MANAGE` | no | yes |

### Project role → capabilities

Effective Project capabilities require **both** a current
`ProjectMembership` and a current `ResearchGroupMembership` in the
Project's ResearchGroup. Without both, the effective capability set is
empty (deny).

| Capability | `viewer` | `member` | `owner` (Project Owner) |
|---|---|---|---|
| `PROJECT_READ` | yes | yes | yes |
| `PROJECT_WORK` | no | yes | yes |
| `PROJECT_MANAGE` | no | no | yes |

### Meeting capabilities

- `MEETING_READ` is granted iff the user created the Meeting or is an
  explicit `MeetingParticipant`. Group/Project membership, ownership, and
  admin status alone do **not** grant Meeting visibility.
- `MEETING_WRITE` is the scoped write rule of the Meeting's scope
  (independent of the creator/participant read rule):
  - group scope: `GROUP_READ` in the Meeting's ResearchGroup;
  - Project scope: `PROJECT_WORK` in the Meeting's Project, and the
    Project is not archived.
- `MEETING_SERIES_READ` / `MEETING_SERIES_WRITE` follow the Meeting scope
  rules for the Series (group scope: `GROUP_READ`; Project scope:
  `PROJECT_READ` / `PROJECT_WORK`, Project not archived for write).

### Default deny

Any resource, capability, role, or account state not explicitly granted by
the mapping above is denied. A valid resource ID alone never grants
access; knowing an ID never bypasses scope membership.

## 6. Collection filtering

List/collection endpoints are permission-filtered server-side: objects the
requesting user may not access are not returned (they are not leaked and
then hidden by the UI). Inaccessible single-resource reads do not reveal
existence (non-leaking 404).

## 7. Deliberately out of scope (not part of this foundation)

- Authentication provider redesign, invitations, passkeys, SSO,
  account-security UI, Membership-management UI.
- Calendar, Knowledge/Wiki, Roadmap, and KVP modules.
- Service accounts / API tokens.
- PostgreSQL Row-Level Security.
