# FG Workspace Documentation Map

This directory is the durable project knowledge base.

The documentation is intentionally split by concern so humans and coding agents can load only the context relevant to the current task.

## Read this, not everything

| Task area | Canonical document |
|---|---|
| Product vision, scope, product milestones | `product.md` |
| Technical stack, architecture, boundaries, development strategy | `architecture.md` |
| Identity, Research Group, Project, Membership, Work Item, Board | `domain/foundation.md` |
| Browser authentication, sessions, cookies, CSRF | `domain/authentication-sessions.md` |
| Membership & authorization invariants (scopes, capabilities, ownership) | `domain/authorization.md` |
| Global account invitations (token bootstrap, lifecycle, non-membership) | `domain/account-invitations.md` |
| Invite-only account registration (redeem an invitation into one account) | `domain/account-registration.md` |
| Meetings, Meeting Templates, Sections, Items, lifecycle, meeting→work | `domain/meetings.md` |
| Activity (awareness/history stream, persisted event contract, Work Item event slice) | `domain/activity.md` |
| Home (personal workspace surface, Needs attention read model) | `domain/home.md` |
| Current implemented vs. not-yet-implemented checkpoint | `CURRENT_STATE.md` |
| Testing, seed/reset, Living Lab, deployment, privacy | `living-lab.md` |
| Canonical agent execution flow, debugging budget, evidence contract, verification boundary | `agent/WORKFLOW.md` |
| UI appearance | relevant file under `stitch_examples/` |
| Color tokens, palette, design tokens | `design/tokens.md` |

Do not read all documents by default.

## Source-of-truth ownership

Each kind of truth has one canonical owner:

- **Product meaning and scope** → `product.md`
- **Technical architecture and development rules** → `architecture.md`
- **Foundation domain semantics and invariants** → `domain/foundation.md`
- **Meeting domain semantics and invariants** → `domain/meetings.md`
- **Activity (awareness/history stream) event contract** → `domain/activity.md`
- **Home personal workspace surface and Needs attention read model** → `domain/home.md`
- **Invite-only account registration (atomic account + invitation transition)** → `domain/account-registration.md`
- **Current implementation checkpoint** → `CURRENT_STATE.md`
- **Living-Lab and validation process** → `living-lab.md`
- **Agent evidence contract (verification claims, blocker classification, completion reports)** → `agent/WORKFLOW.md`
- **Implemented persistence** → Django models + migrations
- **Implemented API contract** → DRF serializers/endpoints
- **Frontend contract representation** → TypeScript API/domain types

`CURRENT_STATE.md` is the sole live checkpoint for the implemented
repository state. Historical checkpoints belong in Git history, not in
parallel status files, and no new aliases or differently-cased
current-status documents may be created.

If implementation and documentation diverge, do not silently choose one. Report the mismatch and resolve it deliberately.

## Change discipline

A durable domain change should follow:

```text
Observation
    ↓
Product decision
    ↓
Canonical documentation
    ↓
Backend model / migration
    ↓
API contract
    ↓
Frontend
    ↓
Tests
```

Do not create versioned copies such as `concept_v0.1.md`, `concept_v0.2.md`, and `concept_v0.3.md` as parallel active sources of truth. Git is the history.

## Stitch exports

`stitch_examples/` contains visual references.

They are not:
- runtime application files,
- the domain model,
- the application architecture.

For a UI task, inspect only the specific Stitch screen relevant to that task.
