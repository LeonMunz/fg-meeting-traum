# FG Workspace — Workspace Sidebar Implementation Contract (Frozen)

**Status:** Frozen implementation contract for the approved Stitch Sidebar.
Documentation-only deliverable — no production source, test, or dependency
file was changed by the task that produced this document, and no
implementation has begun.

**Revision:** v2 (2026-10-05) — the approved Stitch reference assets are
attached in this directory; §3 now fixes the source-of-truth precedence
and the HTML scope lock; QA-9 is corrected to GLOBAL reconciliation
semantics (Research Group boundaries never trigger reconciliation); the
WIP classifications (§9), the RG Overview route wording (§7.3.4, D-1),
and the slice-3 visual product-file allowlist (§8) are tightened.

**Baseline:** branch `slice/workspace-navigation`, HEAD `5ca1df8`
("Add project quick access client"), working tree containing 9 modified +
5 untracked files — every one of them classified in §9.

**Authority.** For the sidebar's information architecture and behavior,
this document supersedes:

- the per-RG "Implemented Sidebar integration" text in
  `docs/domain/foundation.md` §3b (current working tree), and
- the per-RG Sidebar checkpoint entries in `docs/CURRENT_STATE.md`.

`docs/domain/foundation.md` §3b remains canonical for the parts this
contract reuses unchanged (recency persistence, explicit-open contract,
server-side read-model rules). The approved Stitch reference set
(§3.1) is the VISUAL source of truth under the explicit authority order
in §3.2; this document is the BEHAVIOR / INFORMATION-ARCHITECTURE source
of truth and freezes structure and behavior, not pixels.

## 1. Decision that removes the central ambiguity

**Project shortcuts are GLOBAL. There are no per-Research-Group nested
Project children.**

The approved Stitch architecture renders exactly ONE personal Quick
Access section (up to five Projects, selected from the user's Projects
across ALL accessible Research Groups). No Research Group's `Projects`
row carries a disclosure, and no Project row is rendered below any
Research Group row. Any test, document, or code asserting per-RG nested
Quick Access children is superseded (§6, §7.2). This is normative.

## 2. Approved information architecture (frozen)

```text
Sidebar (fixed 240px left rail)

  PERSONAL (fixed section, unchanged)
    Home            → /
    My Work         → /my-work
    Notes           → /notes

  QUICK ACCESS — global, personal, max 5, FLAT (no disclosure)
    <Project> ×≤5   → /projects/<id>/work-items   (canonical Project entry route)

  RESEARCH GROUPS — section header / context (approved IA element)
    per accessible Research Group, in the persisted personal order:
      [chevron]  <RG name>
        chevron   → disclosure ONLY (toggles that group's persisted
                   expansion; never navigates)
        RG name   → Research Group Overview (approved TARGET route
                   /groups/:groupId — does not exist yet, §7.3.4)
      when expanded — EXACTLY TWO rows, nothing else:
        Projects   → /projects?group=<id>   (RG-scoped full Projects page)
        Meetings   → /meetings?group=<id>   (RG-scoped Meetings page)
      NO individual Project children. NO overflow / three-dot menu.

  BOTTOM (fixed section, unchanged)
    Create research group   (opens the existing CreateResearchGroupDialog)
    Notifications           → /notifications
```

Structural facts:

- Section order is fixed: Personal, Quick Access, Research Groups, Bottom.
- The Quick Access section is independent of every Research Group section
  (it has no disclosure control and no parent row).
- Expanding a Research Group row reveals exactly the two rows `Projects`
  and `Meetings`.
- The Quick Access section has at most five rows, each navigating to the
  canonical Project entry route (`/projects/<id>/work-items`).
- The Research Group section shows every Research Group the user can
  currently read, in the persisted personal order (`researchGroupOrder`,
  deterministic default order for groups missing from it).
- The visible-header treatment of each section (labels, presence, style)
  is VISUAL and follows the reference: restrained uppercase section
  labels for `Quick Access` and `Research Groups`, none for Personal
  (§3.4; `screen.png` is the arbiter).
- Control PLACEMENT within the rail follows the reference
  (`screen.png`): the reference renders `Create research group` as a
  quiet secondary action directly after the Research Groups list and
  `Notifications` in the divider-separated bottom area (the WIP layout
  already matches). This contract fixes the SET of controls and their
  behavior, not pixel placement.
- The reference export contains two elements that are NOT in the
  approved IA — a bottom `Profile & Settings` avatar row and a header
  `Workspace menu` chevron button. They are OUT OF SCOPE for FG (§3.3);
  FG keeps personal account destinations exclusively in the topbar user
  menu.

## 3. Visual source of truth — approved Stitch reference (PRESENT)

### 3.1 Reference assets

All three approved reference assets are present in this directory
(attached 2026-10-05; never modified by the contract tasks):

| Asset | Authority role |
|---|---|
| `docs/design/workspace-sidebar/screen.png` | **VISUAL source of truth** for the Sidebar |
| `docs/design/workspace-sidebar/code.html` | **Geometry / markup reference ONLY** — the Sidebar `<nav>…</nav>` block (lines 139–294) |
| `docs/design/workspace-sidebar/DESIGN.md` | **Advisory Stitch metadata only** ("Kinetic Research Logic" design-system export) |

The `docs/stitch_examples/` exports remain visual references only and
are not the approved Sidebar reference.

### 3.2 Source-of-truth precedence (normative)

Authority order, highest first:

1. **`screen.png`** — VISUAL source of truth for the Sidebar.
2. **`IMPLEMENTATION_CONTRACT.md`** (this document) — behavior /
   information-architecture source of truth.
3. **`code.html`** — geometry / markup reference ONLY for the Sidebar
   `<nav>…</nav>` block.
4. **`DESIGN.md`** — advisory Stitch metadata only.

Conflict rules:

- If `screen.png` and `code.html` differ visually, **`screen.png`
  wins**.
- If Stitch-generated behavior conflicts with this contract, **the
  contract wins** (Stitch is a visual reference, not a behavior
  specification).
- `code.html` is **NOT production code**: it is never copied into the
  application; it provides measurement and markup guidance only.
- `DESIGN.md` **must NOT** replace FG's global design tokens, palette,
  layout system, or component system. The canonical FG token set
  (`docs/design/tokens.md`) remains the implementation authority for
  color, typography, and tokens; the reference's "Paper & Ink" light
  palette, Indigo application styling, Inter/JetBrains Mono type
  system, 1440px container model, 40px page margins, card/shadow
  system, and Material Symbols are never FG requirements.

### 3.3 HTML scope lock (normative)

The relevant HTML scope is ONLY the Sidebar: the `<nav>…</nav>` block
(`code.html` lines 139–294). Everything beginning with the exported
`<!-- TopNavBar -->` marker is OUT OF SCOPE.

The Stitch-generated TopBar, search, Kanban board, page content, light
palette, Indigo application styling, Material Symbols outside the
Sidebar, global page spacing, cards, and invented application behavior
must NEVER become implementation requirements for FG.

Two elements INSIDE the reference `<nav>` are also OUT OF SCOPE for FG
(the contract wins on IA): the bottom `Profile & Settings` avatar row
(FG keeps personal account destinations exclusively in the topbar user
menu) and the header `Workspace menu` chevron button (not in the
approved IA).

### 3.4 Useful Sidebar geometry (measurement guidance only)

The in-scope `<nav>` block may be used as measurement guidance for the
slice-3 visual match, implemented on the canonical FG tokens:

- fixed Sidebar width around **240px** (export: `--sidebar-width:
  240px`);
- compact **~13px** navigation typography (export: `body-sm`
  13px/18px; L1 child rows one step smaller);
- **~28px row rhythm** (primary rows 28px; L1 child rows 26px);
- **shallow nesting**: exactly one level (Research Group →
  Projects/Meetings) with a quiet left-border indent — no deeper
  levels;
- **restrained section labels**: small uppercase tracked labels
  (export: 10px, semibold, `tracking-wider`) for `Quick Access` and
  `Research Groups`; none for Personal;
- **lightweight icon treatment**: ~14px line icons (Personal rows,
  Projects/Meetings, Notifications), ~12px disclosure chevrons on
  Research Group rows, quiet ~6px dot markers on Quick Access rows;
- **active presentation**: pure text emphasis (export: strongest text
  color + medium weight + quiet dot), NO filled background card/pill —
  consistent with QA-14/QA-15;
- **hover**: quiet row background in the reference — FG maps this to
  the canonical hover token, never the reference's literal color.

The reference's dark Sidebar surface and Indigo accents are Stitch
palette: they are never promoted into FG. Visual acceptance is against
`screen.png` itself (human review + the visual harness); `code.html`
values are assistance, and where they and the PNG differ, the PNG wins.
Until slice 3 completes, slice 2 remains limited to MINIMAL styling on
the existing canonical FG tokens.

## 4. Behavioral invariants (frozen)

QA-1 **Global personal max-5.** Quick Access shows at most five Projects
drawn across ALL accessible Research Groups. The list is personal (per
user), one row per Project, and never exceeds five rows in total. The
bound is server-owned.

QA-2 **Recency chooses the cold-load snapshot.** The personal recency
ranking (the user's own explicit Project opens, server-owned
`last_opened_at`) selects the snapshot at COLD LOAD (app/page load). The
server order of the first successful fetch is the STABLE SESSION
SNAPSHOT for the Quick Access section.

QA-3 **Spatial stability.** Visible ordering does not change while
navigating. The route may change the active emphasis only.

QA-4 **Existing candidate stays in its slot when current.** If the
current Project is in the snapshot, it keeps EXACTLY its snapshot
position — no promotion, no displacement, no duplication.

QA-5 **Contextual fifth slot.** A current Project OUTSIDE the snapshot
occupies the LAST (fifth) slot while open: with a full snapshot the
fifth candidate is displaced (and restored once the context ends); with
fewer than five candidates the row is appended. This is CONTEXTUAL
PRESENTATION ONLY — never persisted, never mutates the API response,
never fakes a server item (no fabricated `lastOpenedAt`). The current
Project may appear contextually even when absent from the normal
archived-filtered candidates while it is open.

QA-6 **No live reorder.** A successful `recordProjectOpen` NEVER
reorders, invalidates, or refetches the snapshot. The new personal
ranking surfaces at the next cold load.

QA-7 **Archived / access filtering.** The list includes only Projects
the caller can CURRENTLY read (current `ProjectMembership`); archived
Projects are excluded from the snapshot; recency rows are never read as
authorization and no other user's recency is ever consulted.

QA-8 **One global fetch, no fan-out.** The client performs exactly ONE
global Quick Access request per cold load. The client NEVER fetches a
per-Research-Group Quick Access endpoint for the Sidebar (the per-RG
endpoint `GET /api/research-groups/{groupId}/project-quick-access/` is
not consumed by the Sidebar).

QA-9 **Authoritative lifecycle reconciliation (global; corrected).**
The GLOBAL stable snapshot (QA-2) remains stable across ALL ordinary
Project navigation. **Research Group boundaries do NOT trigger
reconciliation**: a normal navigation Project A → Project B must NOT
refetch or reorder Quick Access merely because A and B belong to
different Research Groups. Research Group identity is irrelevant to
snapshot stability.

The stable server snapshot is never reordered or invalidated by
navigation, tab changes, switching the current Project (the CONTEXTUAL
presentation is recomposed per QA-4/QA-5 without touching the snapshot),
or a successful `recordProjectOpen` (QA-6).

Authoritative reconciliation (snapshot cache invalidation + refetch) is
allowed ONLY when there is EVIDENCE that the candidate set itself may be
invalid/stale — for example: archive, delete, access loss, or another
explicit lifecycle mutation that changes Project eligibility. When it
fires, the in-flight response is dropped (race guard), the section
resets and refetches the authoritative list, and a later late response
can never resurrect a reconciled row (so a stale candidate such as an
archived / deleted / inaccessible Project is never presented as
currently eligible).

The current-Project contextual row (QA-5) stays visible within its slot
rules while the concrete Project route is active, including an archived
current Project that is being viewed.

**Slice-2 implementation issue (recorded, not resolved here):** the
client currently exposes NO clean lifecycle signal covering all of these
evidence cases (the WIP route-based "different Research Group" trigger
is WITHDRAWN and must not be carried over). Slice 2 must define the
minimal evidence set (e.g. the authoritative `getProject` failure for
the current Project; reconciliation no later than the next cold load as
the authoritative backstop) — it must NOT invent a route-based refetch
rule.

QA-9 remains compatible with QA-2 (stable cold-load snapshot), QA-3
(spatial stability), and QA-6 (no live reorder): reconciliation is a
stale-data correction, never a navigation-triggered reorder.

QA-10 **RG disclosure and RG-name navigation are separate controls.**
The chevron toggles ONLY that group's persisted expansion (complete
`WorkspaceNavigationPreferences` snapshot semantics retained; multiple
groups may stay expanded; no navigation). The RG name navigates (QA-11).
Activating one control never activates the other.

QA-11 **RG name navigates to the Research Group Overview.** The RG name
row is a pure navigation control to the group's Overview at the approved
TARGET route `/groups/:groupId` (does not exist yet — §7.3.4). The WIP
"select-in-place" behavior (`handleGroupSelect` with its contextual
routing) is superseded.

QA-12 **No RG overflow menu.** No three-dot / overflow menu exists on
any Research Group row (the WIP `GroupOverflowMenu` is removed).

QA-13 **Projects / Meetings destinations.** `Projects` navigates to the
RG-scoped full Projects page (`/projects?group=<id>`); `Meetings`
navigates to the RG-scoped Meetings page (`/meetings?group=<id>`).

QA-14 **Active presentation is text/icon emphasis only.** The selected
row changes text/icon emphasis (canonical selected-row treatment — the
strongest text token); it never paints a background fill, border, pill,
or geometry change.

QA-15 **Expanded is not selected.** Expansion (chevron rotation) paints
no selection treatment; the two states are independent.

QA-16 **No Project children.** No Project row is rendered under
`Projects` or anywhere below a Research Group row.

QA-17 **Central open recording (retained).** Explicit Project opens are
recorded from ONE route-level integration keyed by the entered concrete
Project (covering list → Project, Shortcut → Project, any other
navigation → Project, and deep links): exactly one non-blocking write
per logical route entry — tab changes inside the same Project do not
re-record, leaving and re-entering records a new open, a different
Project records its own, and StrictMode effect replay cannot duplicate
the logical open. The write never carries a timestamp, never mutates
preferences, and its failure never blocks navigation or rendering.

QA-18 **Group ordering (retained).** Research Group rows render in the
persisted personal order; reordering UI (drag/drop) remains out of
scope.

## 5. Current architecture (WIP working tree, FACT)

The working tree contains a per-Research-Group nested Quick Access
implementation:

- Each Research Group row: disclosure chevron + name button
  (select-in-place via `handleGroupSelect`) + admin-only
  `GroupOverflowMenu` (three-dot → Settings).
- Expanding a group reveals `Projects` (itself a disclosure node
  toggling persisted `expandedProjectSections`) and `Meetings`.
- Under an expanded `Projects` node: a per-group Quick Access branch —
  lazily fetched per group (`fetchProjectQuickAccess(groupId)` when the
  branch becomes effectively expanded), cached per group, race-guarded
  per group, composed by `composeProjectShortcuts` (stable snapshot +
  contextual fifth slot), with leave-reconciliation of the leaving
  group's cache.
- Personal nav (Home / My Work / Notes), persisted group order + RG
  disclosure (`WorkspaceNavigationPreferences` GET/PATCH complete
  snapshot, hydration + 300 ms debounced save), central
  `recordProjectOpen` from the Project detail route entry, and the
  bottom zone (Create research group + Notifications).
- Committed baseline on the branch: `84015ea` (preferences backend),
  `6b01b2a` (preferences client), `38defd6` (hierarchical sidebar),
  `8520013` (recency backend + per-RG QA endpoint + 28 tests),
  `5ca1df8` (QA client).

Target architecture: §2 (global flat Quick Access; RG rows with
disclosure + Overview navigation and exactly two non-disclosable child
rows; no overflow menu; unchanged Personal and Bottom zones).

## 6. Current → target mapping

| Current (WIP) element / behavior | Location | Target disposition |
|---|---|---|
| Personal nav Home / My Work / Notes | `Sidebar.tsx` `personalNavigation` | KEEP unchanged |
| Brand header (FG mark + "FG Workspace / Research OS") | `Sidebar.tsx` | KEEP (visual details pending §3) |
| RG row chevron (disclosure) | `Sidebar.tsx` | KEEP — disclosure only (QA-10) |
| RG row name (select-in-place, contextual routing) | `Sidebar.tsx` `handleGroupSelect` / `GROUP_LIST_PATHS` / `navigateOnGroupSelect` | REPLACE — pure navigation to the approved-TARGET RG Overview route `/groups/:groupId` (does not exist yet — QA-11, §7.3.4); select-in-place + contextual group switching from the Sidebar is superseded (scoped list pages keep their `?group=` semantics; switching groups happens via Overview → Projects/Meetings) |
| RG overflow / three-dot menu (admin → Settings) | `Sidebar.tsx` `GroupOverflowMenu` | REMOVE (QA-12) |
| RG manual + contextual disclosure state | `Sidebar.tsx` `groupDisclosureState` | KEEP manual; contextual reveal (route `?group=` scope, group settings, current Project's owning group) stays presentation-only, never persisted |
| `Projects` row disclosure chevron | `Sidebar.tsx` `toggleProjectsSection` | REMOVE (QA-16) |
| `Projects` label → `/projects?group=<id>` | `Sidebar.tsx` | KEEP (QA-13) |
| `Meetings` row → `/meetings?group=<id>` | `Sidebar.tsx` | KEEP (QA-13) |
| Per-group Quick Access branch (render + states) | `Sidebar.tsx` QA rendering | REPLACE with the global flat Quick Access section |
| Per-group lazy fetch state machine (`quickAccessByGroup`, per-group sequence guards, gated lazy effect) | `Sidebar.tsx` | REPLACE with ONE global cold-load fetch; the request-sequence race-guard concept is retained for the single global request (QA-8) |
| Contextual current-Project composition (snapshot slot + fifth contextual slot) | `projectQuickAccess.ts` `composeProjectShortcuts` | KEEP the rule unchanged; input becomes the global snapshot (QA-4/QA-5) |
| Cache invalidation on lifecycle evidence (WIP: "leave-reconciliation" of the leaving group's cache) | `Sidebar.tsx` reconciliation effect | KEEP the concept (drop in-flight response, race guard, refetch on authoritative evidence); trigger semantics CORRECTED per QA-9 — Research Group boundaries do NOT trigger reconciliation |
| Central route-entry open recording | `Sidebar.tsx` open effect + `recordProjectOpen` | KEEP unchanged (QA-17) |
| Preferences hydration + debounced complete-snapshot save | `Sidebar.tsx` | KEEP for `researchGroupOrder` + `expandedResearchGroups`; STOP consuming `expandedProjectSections` in the UI (§7.3 item 5) |
| Quick Access loading / error-Retry / empty states | `Sidebar.tsx` | KEEP the state concept for the global section (compact; section never collapses) |
| Bottom zone: Create research group + Notifications | `Sidebar.tsx` | KEEP unchanged |
| `activeResearchGroupId` (click-set provider state) | `useResearchGroup` | REPLACE with route-derived group context (decision D-3) |
| Visual system (`NAV_ROW*` constants, Paperclip-level density, 13px/16px icons) | `Sidebar.tsx` | SUPERSEDED — minimal FG-token styling in slice 2; exact Stitch geometry in slice 3 |
| `lucide-react` icon set (WIP dependency) | `apps/web/package.json`, `package-lock.json` | KEEP (icon language reused; D-8) |

## 7. Contracts

### 7.1 A — Reusable contracts (survive unchanged)

- **`ProjectNavigationRecency` persistence** — model
  (`projects/models.py`) + migration `projects/0007`: OneToOne to
  `ProjectMembership` (CASCADE), server-owned `last_opened_at`,
  membership-scoped, never authorization-bearing.
- **Explicit Project-open recording** — service
  `record_project_open` + `POST /api/me/projects/{projectId}/open/`
  (body ignored; non-leaking 404; no Activity / preference / Project
  mutation).
- **Frontend open client** — `recordProjectOpen(projectId)` in
  `apps/web/src/api/project-quick-access.ts` + its contract tests.
- **Stale-response guards** — request-sequence numbers that drop
  superseded in-flight responses (per-group map today; one global
  counter tomorrow — identical concept).
- **Stable-snapshot behavior** — QA-2/QA-3/QA-6 (recency chooses the
  cold-load snapshot; navigation never live-reorders; open writes never
  invalidate).
- **Max-5 composition concept** — `composeProjectShortcuts` +
  `MAX_PROJECT_SHORTCUTS` + `CurrentProjectShortcut` + the full
  `projectQuickAccess.test.ts` suite (rules are input-agnostic: they
  apply verbatim to the global snapshot).
- **Current-Project metadata resolution** — bounded `getProject`
  per concrete Project route entry, race-guarded, name/group/archived
  state never inferred from the URL.
- **Preference hydration** — `WorkspaceNavigationPreferences`
  GET/PATCH complete-snapshot API (committed), hydration effect,
  debounced save with dirty-check and save-sequence guard — for
  `researchGroupOrder` + `expandedResearchGroups`.
- **RG disclosure persistence** — `expandedResearchGroups`
  (manual-only; contextual reveal never persisted).
- **Backend recency test suite** — `projects/tests_project_navigation_recency.py`
  (28 tests): the open-recording cases survive verbatim; the per-RG
  read-model cases are the TEMPLATE for the global read model tests.
- **E2E helpers** — `e2e/helpers.ts` active-group scoping (ARIA
  `group` container + non-ambiguous group-chevron locator) remains
  valid because the group disclosure survives.

### 7.2 B — Superseded contracts (replaced by the Stitch architecture)

- **Per-RG Project shortcut rendering** — the Quick Access branch under
  each group's `Projects` node (`Sidebar.tsx` rendering + states).
- **Nested `Projects` disclosure** — `toggleProjectsSection`, the
  `projectsVisible` presentation state, and UI consumption of
  `expandedProjectSections` (the server field's fate is §7.3 item 5).
- **Per-RG Quick Access fetching used solely for Sidebar children** —
  the client-side consumption of
  `GET /api/research-groups/{groupId}/project-quick-access/` and the
  `fetchProjectQuickAccess` call path in the Sidebar (the endpoint
  itself is retained — §7.4).
- **Cross-Research-Group reconciliation trigger.** The WIP rule that
  reconciled the leaving group's cache when a successor Project of a
  DIFFERENT group resolved is superseded: Research Group boundaries are
  NOT invalidation conditions (QA-9).
- **RG overflow / three-dot menu** — `GroupOverflowMenu`
  (`EllipsisVertical`) and its admin-Settings entry.
- **Select-in-place RG name behavior** — `handleGroupSelect`,
  `navigateOnGroupSelect`, `GROUP_LIST_PATHS` contextual switching from
  the Sidebar (superseded by QA-11).
- **Docs asserting Project children under each RG** — the WIP
  "Implemented Sidebar integration" text in `docs/domain/foundation.md`
  §3b (per-RG branch semantics) is superseded by this contract; the
  per-RG Sidebar checkpoint entries in `docs/CURRENT_STATE.md` remain as
  historical checkpoint records and are superseded by the new checkpoint
  written when slice 2 completes.
- **Obsolete visual harness assumptions** —
  `scripts/visual/sidebar-compact-visual-check.mjs` geometry
  assertions (12.5px type, L2 shortcut indent columns, etc.) pin the
  pre-approval compact system and are replaced in slices 3–4 (the
  harness PATTERN is reusable).
- **WIP tests pinning the nested IA** — the `Sidebar.test.tsx` describe
  blocks for Projects disclosure, per-group Quick Access states,
  per-group stable snapshots, and the contextual per-group branch; plus
  `e2e/project-quick-access-sidebar.spec.ts`. These are REWRITTEN (not
  deleted) in slice 2: every behavioral intent (spatial stability,
  contextual fifth slot, reconciliation, open recording, race guards)
  is preserved and re-anchored on the global section.

### 7.3 C — Required new contracts (smallest clean additions)

1. **Global personal Project Quick Access read model (backend).**
   - Proposed endpoint: `GET /api/me/project-quick-access/` (exact path
     finalized in slice 1; it belongs to the personal `/api/me/`
     namespace, next to `POST /api/me/projects/{id}/open/`).
   - Generalizes `get_personal_project_quick_access` over the caller's
     ENTIRE accessible Project set (no Research Group parameter). The
     composition happens SERVER-SIDE from the existing
     `ProjectNavigationRecency` data — the client never fans out over
     per-RG endpoints.
   - Server-authoritative ordering: personally opened Projects first,
     `last_opened_at` DESC (equal timestamps by primary key DESC); then
     never-opened Projects by `Project.created_at` DESC (equal
     timestamps by primary key DESC).
   - Filters: current canonical Project read access (current
     `ProjectMembership`); archived Projects excluded; recency never
     read as authorization.
   - Bound: five candidates, server-owned.
   - Item shape: `{id, name, researchGroupId, lastOpenedAt}`
     (`lastOpenedAt` null for never-opened Projects). D-2 is RESOLVED
     by the reference: the in-scope nav block renders Quick Access rows
     as a quiet dot + project name only — no per-row Research Group
     label — so the v1 payload carries no `researchGroupName`. A
     per-row RG context, if ever decided later, is a backend payload
     addition, never invented client-side.
   - Empty accessible set / nothing opened → `[]`. No migration (reuses
     existing persistence). No change to the ordinary Project list, the
     per-RG endpoint, or the open-recording contract.
2. **Frontend global Quick Access client + one cold-load fetch.** A thin
   client for the new endpoint (same `apiGet` convention, server
   response returned unchanged) plus exactly one race-guarded fetch per
   cold load in the Sidebar, with compact loading / error-Retry / empty
   states that never collapse the section.
3. **Contextual current-Project composition over the global snapshot.**
   `composeProjectShortcuts` applied unchanged to the global snapshot;
   the current-Project metadata resolution (bounded `getProject`,
   race-guarded) is retained.
4. **Research Group Overview (approved TARGET route).**
   - FACT: no RG Overview route exists yet. The only existing RG route
     is `/groups/:groupId/settings`, which already establishes the
     route family. `/groups/:groupId` is the APPROVED TARGET route — it
     does NOT exist yet and must not be described as an existing
     canonical route. `ResearchGroupPage.tsx` is an orphaned legacy
     component referenced by no route and is NOT the Overview.
   - Target: `/groups/:groupId` (index) rendering a minimal RG
     identity/context page. No new domain data, no new API, no new
     authorization surface. Broad RG Overview functionality is NOT
     invented by this contract; page content scope is decision D-1.
   - The Sidebar RG name navigates to this route (QA-11).
5. **UI retirement of `expandedProjectSections`.** The Sidebar stops
   reading, writing, and rendering this preference field. The server
   field and its sanitization survive until an explicit deprecation
   decision (D-4) — no migration in slices 1–3.

### 7.4 Per-RG Quick Access endpoint (retained, not consumed)

`GET /api/research-groups/{groupId}/project-quick-access/` remains a
valid, tested per-RG read model. The Sidebar no longer calls it (QA-8).
Retire-vs-keep is decision D-5; recommendation: keep, out of scope for
slices 1–3.

## 8. Slice boundaries (independently verifiable, in order)

### Slice 1 — Domain/API contract for global personal Quick Access

- **Dominant outcome:** the server authoritatively composes the global
  personal Quick Access list; a client can consume ONE endpoint; no UI.
- **Exact affected layers/files:**
  - `apps/api/projects/services.py` — global read model (generalization
    of `get_personal_project_quick_access`).
  - `apps/api/projects/views.py` — one personal-scope view.
  - `apps/api/config/urls.py` — one route.
  - `apps/api/projects/tests_project_navigation_recency.py` (or a
    sibling module in `apps/api/projects/`) — global read-model tests.
  - `docs/domain/foundation.md` §3b — global read model contract text.
  - `docs/CURRENT_STATE.md` — checkpoint entry on completion.
- **Behavioral acceptance boundary:** endpoint contract per §7.3.1 —
  ordering, access/archive filtering, five-candidate bound, tie-breaks,
  per-user isolation, empty response, no existence leak, no mutation of
  recency/preferences/Activity; per-RG endpoint and Project list
  contracts byte-for-byte unchanged; no migration.
- **Tests:** mirror the per-RG read-model cases globally: cross-group
  recency ordering (opened Projects from MULTIPLE groups interleaved by
  `last_opened_at`), never-opened fallback, equal-timestamp PK-DESC and
  equal-`created_at` PK-DESC tie-breaks, five-candidate bound, archived
  exclusion, personal isolation, empty.
- **Explicitly out of scope:** any frontend change; the per-RG
  endpoint; the RG Overview page; preference fields; visual work.

### Slice 2 — Frontend data + information-architecture migration (minimal styling)

- **Prerequisite:** decision D-1 resolved (D-2 is already resolved by
  the reference — §7.3.1).
- **Dominant outcome:** the Sidebar renders the frozen IA
  (global flat Quick Access; RG rows with disclosure + Overview
  navigation; exactly two non-disclosable child rows; no overflow
  menu) with MINIMAL styling on the existing canonical FG tokens.
- **Exact affected layers/files:**
  - `apps/web/src/components/layout/Sidebar.tsx` — IA rebuild per §2/§6;
    keeps personal nav, bottom zone, group ordering, preference
    hydration/save, contextual reveal, central open recording.
  - `apps/web/src/api/project-quick-access.ts` (+ its test) — add the
    global fetch client (per-RG client retained).
  - `apps/web/src/app/App.tsx` — `/groups/:groupId` route.
  - `apps/web/src/features/research-group/` — new minimal RG Overview
    page + tests.
  - `apps/web/src/components/layout/Sidebar.test.tsx` — superseded
    blocks rewritten; new global-QA + Overview-navigation tests; fix
    the trailing-blank-line-at-EOF defect (G-1) in the same pass.
  - `apps/web/src/components/layout/projectQuickAccess.ts` — doc
    comment updated to global semantics; composition rules unchanged.
  - `e2e/project-quick-access-sidebar.spec.ts` — replaced by a global
    Quick Access acceptance spec.
  - `e2e/helpers.ts`, `e2e/research-group-scope.spec.ts` — adapt where
    the IA change touches their locators (group-chevron scoping fix
    stays).
  - `apps/api/accounts/management/commands/seed_e2e_scope.py` — comment
    wording updated from per-branch to global; seed extended only if
    the global ordering acceptance needs Projects in a second
    Research Group (D-6).
  - `docs/domain/foundation.md` §3b, `docs/CURRENT_STATE.md` — re-anchor
    the sidebar integration contract on this document.
- **Slice-2 implementation issue (from QA-9):** define the minimal
  client-side lifecycle evidence set (archive / delete / access loss /
  other eligibility mutations) that may trigger snapshot
  reconciliation; do NOT carry over the WIP route-based
  cross-Research-Group trigger; do NOT invent a route-based refetch
  rule.
- **Behavioral acceptance boundary:** QA-1…QA-18 all hold; exactly ONE
  global Quick Access request per cold load (request-count asserted);
  stable snapshot INCLUDING cross-Research-Group Project navigation
  (no refetch, no reorder — QA-9); contextual fifth slot; lifecycle
  reconciliation on evidence only; RG name → Overview; disclosure-only
  chevron; no overflow menu; no Project
  children; personal nav / bottom / group ordering unchanged; complete
  non-browser frontend verification green
  (`./scripts/agent-verify.sh frontend`), targeted E2E for the new spec
  in a browser-capable environment.
- **Tests:** rewritten `Sidebar.test.tsx` blocks + new global-QA and
  Overview tests; new E2E spec; existing non-superseded suites stay
  green (including `Sidebar.research-group-creation.test.tsx`).
- **Explicitly out of scope:** Stitch-specific visual values (density,
  type scale, icon swaps, spacing, header treatments); visual
  regression lock; any backend change; deprecating the
  `expandedProjectSections` API field; RG drag/drop.

### Slice 3 — Exact Stitch presentation match

- **Reference status:** the approved reference set (§3.1) is PRESENT in
  this directory — `screen.png` (visual source of truth), `code.html`
  (measurement assistance only), `DESIGN.md` (advisory only). The slice
  is NO LONGER blocked on missing assets; visual acceptance is against
  `screen.png` itself.
- **Hard product-file allowlist:** the visual slice may modify ONLY
  `apps/web/src/components/layout/Sidebar.tsx` and
  `apps/web/src/components/layout/Sidebar.test.tsx`. It must NOT modify
  AppShell outside the Sidebar, TopBar, page content, the Projects
  pages, the Meetings pages, Home/My Work/Notes content, the backend,
  the APIs, or the global design system. If any other PRODUCTION file
  appears necessary for visual matching, the agent must STOP and report
  why rather than widening scope automatically. Functional/API
  migrations belong to earlier slices. (The `scripts/visual/`
  measurement harness is a development tool, not a product file, and is
  updated in this slice for measurement only.)
- **Dominant outcome:** the Sidebar presentation matches the approved
  reference (geometry, type, icons, emphasis, hover, disclosure) using
  the canonical FG tokens.
- **Exact affected layers/files (product-file allowlist applies):**
  - `apps/web/src/components/layout/Sidebar.tsx` — presentation layer
    only (classes/constants); NO IA, data-flow, or behavior change.
  - `apps/web/src/components/layout/Sidebar.test.tsx` — stale
    selectors may be updated only where product behavior is unchanged.
  - `docs/design/tokens.md` — only if the approved reference forces a
    token-mapping DECISION (no new token families without an explicit
    architecture decision; `DESIGN.md` is advisory — §3.2).
  - `scripts/visual/sidebar-compact-visual-check.mjs` — geometry
    assertions replaced by the reference-derived measurements
    (development harness, not a product file).
- **Behavioral acceptance boundary:** the visual check passes in a
  host terminal with a working browser (agent sandbox: browser
  execution is `blocked_sandbox` — the E2E gate rules apply and the
  exact host command is reported); all IA/behavior tests from slice 2
  stay green; no product copy or behavior changes made for selector
  convenience.
- **Tests:** updated visual check script; existing suite unchanged.
- **Explicitly out of scope:** IA changes, data-contract changes,
  backend changes.

### Slice 4 — Visual-regression lock after human acceptance

- **Prerequisite:** human visual acceptance of slice 3, recorded.
- **Dominant outcome:** the accepted presentation is locked as a
  reproducible regression gate with committed baselines.
- **Exact affected layers/files:** final form of the visual check
  script; committed baseline fixtures (canonical location is decision
  D-7 — generated `.artifacts/` are never committed); a pointer from
  `docs/living-lab.md` or this directory.
- **Behavioral acceptance boundary:** the check is reproducible on a
  host terminal; a baseline diff fails on unauthorized presentation
  changes; the human sign-off is recorded in the checkpoint docs.
- **Explicitly out of scope:** any functional change of any kind.

## 9. WIP safety — file classification (complete)

Working tree at contract time: 9 modified + 5 untracked WIP files
(the three reference assets in this directory were attached after the
first contract pass and are not WIP). NOTHING is deleted, stashed,
reset, committed, or modified by the contract tasks.

| # | File | State | Classification | Rationale / slice notes |
|---|---|---|---|---|
| 1 | `apps/api/accounts/management/commands/seed_e2e_scope.py` | modified | **KEEP / reusable** | Two extra deterministic Projects ("E2E Robot Calibration", "E2E Robot Assembly") still serve the Quick Access acceptance (needs ≥3 visible shortcuts); the "ONE branch" comment wording is updated in slice 2; seed extension for a second RG only if D-6 requires it |
| 2 | `apps/web/package.json` | modified | **KEEP** | `lucide-react` icon dependency — the target design also uses text/icon emphasis; retained unless the approved reference dictates otherwise (D-8) |
| 3 | `apps/web/src/components/layout/Sidebar.test.tsx` | modified | **MODIFY in future slice** | Personal-nav, RG-tree, preference, and group-creation tests survive; the nested-IA blocks (Projects disclosure; per-group QA states; per-group stable snapshots; contextual per-group branch) are rewritten in slice 2 with the behavioral intents preserved; must also fix the trailing blank line at EOF (G-1) |
| 4 | `apps/web/src/components/layout/Sidebar.tsx` | modified | **MODIFY in future slice** | Core state/behavior (ordering, hydration, contextual reveal, open recording, bottom zone) carried over; QA branch, `Projects` chevron, `GroupOverflowMenu`, select-in-place routing, and the visual system are replaced in slices 2–3 |
| 5 | `docs/CURRENT_STATE.md` | modified | **MODIFY in future slice** | The WIP checkpoint entries describe the per-RG/nested Sidebar and must be reconciled with the approved global architecture as the slices complete; historical entries stay but are superseded for the sidebar by the new per-slice entries |
| 6 | `docs/domain/foundation.md` | modified | **MODIFY in future slice** | §3b recency core (persistence, open contract, per-RG read model) stays canonical; the WIP "Implemented Sidebar integration" (per-RG branch) is superseded by this contract and re-anchored in slice 2 |
| 7 | `e2e/helpers.ts` | modified | **KEEP / reusable** | Active-group scoping (ARIA group container + `aria-current` label) and the non-ambiguous group-chevron locator remain valid — the group disclosure survives the redesign |
| 8 | `e2e/research-group-scope.spec.ts` | modified | **KEEP** | The `aria-controls^="research-group-children-"` locator fix is still required (group chevron vs. any remaining disclosure disambiguation) |
| 9 | `package-lock.json` | modified | **KEEP** | `lucide-react` lock entry matching `apps/web/package.json` |
| 10 | `apps/web/src/components/layout/computed-style-probe.disabled.txt` | untracked | **DIAGNOSTIC / delete** | Self-described throwaway forensic probe, disabled by file extension, no behavior depends on it; remove when the WIP is finalized (slice 2 pass) |
| 11 | `apps/web/src/components/layout/projectQuickAccess.ts` | untracked | **MODIFY / reusable core** | The pure composition logic survives unchanged — max-5, in-snapshot position kept, contextual last slot, no mutation are EXACTLY the target rules (QA-4/QA-5); its documentation and integration change from per-RG to global Quick Access semantics in slice 2 |
| 12 | `apps/web/src/components/layout/projectQuickAccess.test.ts` | untracked | **MODIFY / reusable core** | The composition tests survive; the target global integration may require adjusted/additional contract coverage in slice 2 |
| 13 | `e2e/project-quick-access-sidebar.spec.ts` | untracked | **MODIFY / REWRITE** | Preserve behavioral acceptance for: max 5, stable ordering, active Project, contextual fifth slot, lifecycle reconciliation (QA-9 semantics), and open recording — but replace the nested per-RG IA assumptions (expand group → expand Projects → shortcuts under the branch) with the global section in slice 2 |
| 14 | `scripts/visual/sidebar-compact-visual-check.mjs` | untracked | **SUPERSEDED** (harness pattern reusable) | Geometry assertions pin the pre-approval compact system (type scale, L2 indent columns); replaced by Stitch-derived assertions in slices 3–4; the real-component + real-CSS measurement harness pattern is retained |

## 10. Known risks / unresolved decisions

Decisions (must be resolved where a slice is blocked):

- **D-1 — RG Overview page content.** The route is required by QA-11 as
  the APPROVED TARGET `/groups/:groupId` (it does not exist yet;
  `/groups/:groupId/settings` already establishes the route family).
  The reference's page content is an out-of-scope Kanban page (§3.3),
  so the content is not fixed by the approved decisions or the
  reference. Recommendation: minimal identity/context page (group name,
  group context; links to the RG-scoped Projects/Meetings pages; no new
  domain data, API, or authorization). Broad RG Overview functionality
  is NOT invented by this contract. BLOCKS slice 2.
- **D-2 — Research Group context on Quick Access rows. RESOLVED by the
  reference (2026-10-05).** The in-scope nav block renders Quick Access
  rows as a quiet dot + project name only — no per-row Research Group
  label (`code.html` nav block; `screen.png` is the arbiter). The v1
  payload stays `{id, name, researchGroupId, lastOpenedAt}`; a per-row
  RG context, if ever decided later, is a backend payload addition.
- **D-3 — Active Research Group state.** The WIP click-set
  `activeResearchGroupId` becomes route-derived (the `?group=` scope,
  the RG Overview, or the current entity's owning group) once the RG
  name no longer "selects". Scoped list pages keep their `?group=`
  semantics. Pinned during slice 2.
- **D-4 — `expandedProjectSections` server field.** UI consumption
  stops in slice 2; the model/API field (committed) is retained —
  harmless, sanitized on every read/write — until an explicit
  deprecation decision (separate slice; would need a migration + API
  change).
- **D-5 — Per-RG Quick Access endpoint.** Retained (tested, valid
  per-RG read model, no UI consumer) unless explicitly retired; out of
  scope for slices 1–3.
- **D-6 — E2E seed shape.** Whether the global ordering acceptance
  needs Projects in a second Research Group (the current seed adds
  both extra Projects to one group). Resolved in slice 2.
- **D-7 — Committed visual baseline location** for slice 4 (generated
  `.artifacts/` are never committed).
- **D-8 — Icon set.** `lucide-react` (WIP addition) is retained unless
  the approved reference dictates otherwise; a different icon approach
  is a scope decision, not an implementation detail.

Known defects / risks:

- **G-1 — WIP hygiene (FACT):** `apps/web/src/components/layout/Sidebar.test.tsx`
  has a trailing blank line at EOF (added by the WIP; the file is the
  last file in the diff), so `git diff --check` fails in the CURRENT
  baseline: `Sidebar.test.tsx:2686: new blank line at EOF.` It must be
  removed when the WIP is finalized — slice 2 touches the file anyway.
  Until then "git diff --check clean" is not achievable without
  modifying a WIP test file, which this documentation task is
  forbidden to do.
- **R-1 — Reference assets PRESENT (RESOLVED 2026-10-05).** The former
  missing-asset block on slice 3 is removed; the reference set is in
  this directory (§3.1). Note for the record: in the revision session
  `screen.png` could not be visually inspected in-agent (no image
  input); the §3.4 geometry facts derive from `code.html` (the
  designated geometry/markup reference for the nav block) and
  `DESIGN.md` metadata. Visual acceptance against `screen.png` itself
  (human review + visual harness) remains mandatory in slices 3–4.
- **R-2 — Large superseded test surface.** The WIP added ~2000 lines of
  nested-IA tests; the slice-2 rewrite must preserve every behavioral
  intent (spatial stability, contextual fifth slot, lifecycle
  reconciliation per QA-9, open-recording, race guards) — regression
  risk is managed by reusing the existing test structures and fixtures.
- **R-3 — Reconciliation edge cases.** The archived/deleted
  current-Project cases that the WIP reconciliation fixed (pinned E2E
  failures) are exactly the lifecycle-EVIDENCE cases QA-9 retains; they
  are explicit slice-2 acceptance items, alongside the new NEGATIVE
  case: a cross-Research-Group Project navigation must NOT refetch or
  reorder the snapshot.
- **R-4 — Admin settings discoverability.** Removing the overflow menu
  changes the admin's path to Research Group settings (now reachable
  via the canonical `/groups/:groupId/settings` route, e.g. from the
  Overview page); slice-2 acceptance includes verifying the path is
  discoverable.

## 11. Task record (documentation-only)

- v1 (2026-10-05): created
  `docs/design/workspace-sidebar/IMPLEMENTATION_CONTRACT.md` (new
  file; new directory `docs/design/workspace-sidebar/`) — nothing
  else.
- v2 (2026-10-05): reference-attach revision — only this file changed;
  the three reference assets (`screen.png`, `code.html`, `DESIGN.md`)
  were attached by the task and remain byte-for-byte untouched.
  Authority order fixed (§3.2), HTML scope lock added (§3.3), geometry
  facts recorded (§3.4), QA-9 corrected to global reconciliation
  semantics, WIP classifications corrected (§9), route wording
  corrected (§7.3.4/D-1), slice-3 product-file allowlist added (§8).
  In that session `screen.png` could not be visually inspected in-agent
  (no image input); §3.4 geometry facts derive from `code.html` (the
  designated geometry/markup reference for the nav block); all visual
  acceptance remains against `screen.png` itself.
- No production source, no tests, no dependency files changed.
- No commit, push, stash, reset, or deletion performed.
- Verification gates for the contract tasks: see the accompanying
  completion reports (git-based evidence only; no browser/product path
  executed).
