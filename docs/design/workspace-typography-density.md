# FG Workspace — Workspace Typography & Density Contract

**Status:** Canonical contract for semantic typography; the density
section (§2) is **provisional** by explicit status. Documentation only —
no production source, test, token, Tailwind, radius, border, or spacing
change is introduced by this document.

**Revision:** v2 (2026-10-06) — v1 was the one-off audit report
(recovered from Git history if needed); v2 is the durable contract.
Baseline of all measurements: `4453f5e`.

**Scope:** semantic typography roles for Workspace content pages +
density (size) metrics for the Projects/Meetings reference migration.
Surfaces measured: Sidebar (anchor), Projects list
(`features/projects/ProjectListPage.tsx`), Meetings list
(`features/meetings/MeetingListPage.tsx` + `UpcomingMeetings.tsx`),
incl. every loading / empty / error state.

**Calibration anchor (normative).** The accepted, frozen Workspace
Sidebar (`components/layout/Sidebar.tsx`, governed by
`workspace-sidebar/IMPLEMENTATION_CONTRACT.md`) is the visual
calibration reference. Content pages calibrate *against* it; they never
inherit Sidebar sizing as their own scale — hierarchy stays semantic
(content type ≥ chrome type).

**Font & weight rules.** Inter for UI text (existing). Allowed weights:
**400 / 500 / 600** — nothing else. JetBrains Mono remains reserved for
data identifiers. Line-height convention: values are written
`size / line`; where a page currently uses a Tailwind utility default
(e.g. `text-[13px]` → line-height 1.5), the contract value replaces it.

**Authority position.** This document is a global visual design contract
(`docs/design/README.md` is the design source-of-truth map). It refines
nothing in `tokens.md` (color/theme/focus stays canonical there) and is
refined by scoped contracts only where a scoped surface freezes different
values (Sidebar). Production code implements this contract; it does not
silently redefine it.

---

## 1. Canonical semantic typography roles (SETTLED)

These roles are settled semantic typography for FG Workspace content.
They are size/line/weight contracts — not yet theme tokens (no
`@theme` introduction until an explicit tokenization decision).

| FG role | Size / line | Weight | Use |
|---|---|---|---|
| `page-title` | 24 / 28 | 600, `tracking-tight` | List-page `<h1>` only |
| `section-heading` | 16 / 22 | 600 | Empty/error/structural headings (no-match, no-group, coming-soon, page-error) |
| `record-title` | 14 / 20 | 600 | Primary line of a data record: Project name, Meeting title, row Time |
| `primary-content` | 14 / 20 | 400 (500 for emphasized lead-in) | Subtitle, empty-state body, banner text, toast title |
| `control` | 13 / 18 | 500 | Buttons, chips, tabs, input text, banner Retry |
| `meta` | 12 / 16 | 400 | Secondary record line, attendee text, timestamps, toast sub, state rows |
| `micro` | 11 / 16 | 500 | Column headers, mobile inline column labels, badges, counters |

**Sidebar chrome exceptions (already frozen — no change).** The
Sidebar keeps its frozen scale, defined in
`workspace-sidebar/IMPLEMENTATION_CONTRACT.md` §3.4: primary nav
**13px**, child nav **12px**, section label **10px** (600, uppercase,
`tracking-wider`), brand block 14/600 + 11/400. The 10px label is the
only sanctioned value below `micro`; content pages must not go smaller
than 11px. Content must not simply inherit Sidebar sizing.

**Exception — record weight.** `record-title` keeps 600 even though
`primary-content` is 400: both accepted pages use 600 for the record
primary line, and dropping to 400/500 would flatten the accepted
600-vs-400 hierarchy. 600 is reserved for `page-title`,
`section-heading`, `record-title`, and the brand block.

## 2. Provisional density metrics (Projects/Meetings reference migration)

The values below are **current implementation targets for the
Projects/Meetings reference migration — NOT yet universal product
invariants.** They become global invariants only after browser
validation and explicit acceptance. Until that acceptance exists, do
not cite 32px / 36px / 40px / 68px as frozen or universally canonical.

| Density role | Value | Status / note |
|---|---|---|
| Compact control (inline banner actions) | 32px | provisional target (matches current banner Retry) |
| Normal page control (buttons, chips, search, row overflow, empty CTAs) | 36px | provisional target (the de-facto page control of Meetings) |
| Structural 40px band | 40px | provisional, only where justified (Meetings tab strip; dialogs reserved) — never a general button height |
| Two-line record row (Projects + Meetings) | 68px min | provisional target; matches both accepted pages (`min-h-[68px]`); rows may grow (tablet meta wrap) |
| Single-line data row | 40px | reserved — no single-line rows on scope pages today |
| List header bands | column header 36px · section header 32px | provisional; roles stay distinct (scannable columns vs in-list group anchor) |
| Icon steps | 14 / 16 / 18 / 24px | provisional target: nav-structural / meta-inline / control / empty-state display |

Frozen chrome density stays governed by the Sidebar contract (nav rows
28px / 26px, brand band 64px, rail 240px) and is not re-declared here.
The 1280px content-frame cap stays governed by the
`WorkspaceContent` contract (`docs/architecture.md`, "Workspace
content width") — unchanged.

**28px is chrome-only** (Sidebar nav rows, frozen). Content-page
compact inline actions are 32px; 28px is never a content control
height. **40px is reserved, not a default:** the two current 40px page
controls (Projects primary, search) normalize to 36px in the migration.

## 3. Current → target mapping (implementation table)

Δ = change required by this contract; keep = already at target.
All Sidebar roles are **keep** (frozen — no change, no migration).

### 3.1 Projects (`ProjectListPage.tsx`)

| Role | Current | Target | |
|---|---|---|---|
| Page title | 30/36 · 600 | `page-title` 24/28 · 600, `tracking-tight` | Δ |
| Subtitle | 14/24 (`leading-6`) · 400 | `primary-content` 14/20 | Δ |
| New project (primary) | 40px · 14/20 · 600 · 19px icon | 36px · `control` 13/18 · 500 · 18px icon | Δ |
| Status filter chips | 36px · 14/20 · 500 | 36px · 13/18 · 500 | Δ |
| Archived chip | + 17px icon · count 11px/400 | + 16px icon · count `micro` 11/16 · 400 | Δ icon |
| Search field | 40px · 14/20 · 400 | 36px · `control` 13/18 · 400 · 18px icon | Δ |
| Table header band | 36px · 11px · 400 | 36px · `micro` 11/16 · 500 | Δ |
| Data row | min-68px · 14px v-pad | 68px min · 12px v-pad (anatomy aligned to Meetings) | Δ anatomy |
| Project name | 14/20 · 600 | `record-title` | keep |
| Description | 12/16 · 400 | `meta` | keep |
| Status / Role / Updated cells | 12/16 · 400 · 6px dot · 15px icons | `meta` · icons 16px | Δ icon |
| Row hover chevron | 17px | 18px | Δ |
| Mobile inline column labels | 10/15 · 400 | `micro` 11/16 · 500 | Δ |
| Empty/error heading | 16/24 · 600 (one 14/20 outlier) | `section-heading` 16/22 · 600 (outlier promoted) | Δ |
| Empty/error body | 14/24 · 400 | `primary-content` 14/20 | Δ |
| Empty display icon | 48px circle · 22–23px glyph | 48px circle · 24px glyph | Δ |
| Empty CTA / Retry | 36px · 14/20 · 500–600 | 36px · `control` 13/18 · 500 · 18px icon | Δ |
| Skeleton | h-9 band · min-68px rows · bars | unchanged | keep |

### 3.2 Meetings (`MeetingListPage.tsx` + `UpcomingMeetings.tsx`)

| Role | Current | Target | |
|---|---|---|---|
| Page title | 30/36 · 600 | `page-title` 24/28 · 600 | Δ |
| Subtitle | 14/24 (`leading-6`) · 400 | `primary-content` 14/20 | Δ |
| Meeting Templates | 36px · 14/20 · 600 · 18px icon | 36px · `control` 13/18 · 500 | Δ |
| New meeting (primary) | 36px · 14/20 · 600 · 18px icon | 36px · `control` 13/18 · 500 | Δ |
| Tab strip | 40px strip · 14/20 · 500 | 40px strip · 13/18 · 500 | Δ type |
| Date-group header | 32px · 12/16 · 600 | keep (list section header, 32px band) | keep |
| Row | min-68px · 12px v-pad | 68px min · unchanged | keep |
| Time | 14/20 · 600 · tabular | `record-title` | keep |
| Meeting title | 14/20 · 600 | `record-title` | keep |
| Attendee/meta line | 12/16 · 400 · 16px glyph | `meta` | keep |
| Status badge | 11px · 500 | `micro` 11/16 · 500 | keep |
| People column (desktop) | 14/20 · 400 | `meta` 12/16 · 400 (attendee text is secondary data) | Δ |
| Row overflow action | 36px · 18px glyph | unchanged | keep |
| Banner text (feed/open error) | 14/20 · 400 (500 lead-in) | `primary-content` | keep |
| Banner Retry / Try again | 32px · 12/16 · 600 · 16px icon | 32px · `control` 13/18 · 500 | Δ |
| Page-error / ComingSoon / no-group | 16/24 · 600 + 14/24 · 400 · 28px glyph | 16/22 · 600 + 14/20 · 400 · 24px glyph | Δ |
| Upcoming empty | 16/24 · 600 · 30px glyph · CTA 36px | 16/22 · 600 · 24px glyph · CTA `control` 13/18 · 500 | Δ |
| Series-created toast | 14/20 · 500 + 12/16 · 400 | unchanged | keep |
| Skeleton rows | min-68px · bars | unchanged | keep |

## 4. Rationale — audit findings (why the targets differ from HEAD)

1. Primary page button height split: Projects 40px vs Meetings 36px
   (adjacent color split `bg-action` vs `bg-accent` — color scope,
   flagged, not part of this contract).
2. Search field 40px — the only other 40px page control.
3. Content-page controls 14px/500–600 vs the 13px calibration anchor.
4. Page titles 30px (`text-3xl`) — editorial scale for a dense app.
5. Subtitle `leading-6` split (14/24 vs 14/20 elsewhere) and one
   14px empty-state heading among 16px siblings (Projects).
6. Off-grid icon sizes 15/17/19px and empty-state glyphs 22–30px
   (not even consistent within one page).
7. Two different list-header treatments with no shared role
   (36px/11px column vs 32px/12px section).
8. Same 68px row with different padding anatomy (14px vs 12px v-pad);
   checkpoint drift: `CURRENT_STATE.md` says "64px min, 14px padding"
   while code is `min-h-[68px]` + `py-3` — code is the accepted state.
9. Page frame padding split (`lg:py-10 xl:px-10` on Projects only) —
   spacing implication, not redesigned here.
10. Non-canonical colors on Projects (raw-palette status dots; legacy
    `text-on-surface-variant/75` column header) — color scope, flagged.

## 5. Deliberate deviations (exception register)

- **E-1** Sidebar section label 10px — frozen; below `micro` by
  exception only.
- **E-2** `record-title` 600 — preserves the accepted record
  hierarchy (see §1 exception).
- **E-3** Two-line row 68px, not the once-provisional 52–56px —
  both accepted pages are 68px; tightening is a future density
  decision requiring its own acceptance.
- **E-4** People column 12px — attendee text is secondary data,
  consistent with the 12px meta line it folds into on tablet.
- **E-5** 28px chrome-only; content compact inline = 32px.
- **E-6** 40px reserved (tab strip / dialogs), not a default.
- **E-7** Column-header (36px) and section-header (32px) roles stay
  distinct — different information jobs.

## 6. Open validation & watch items (carry into the migration)

- **V-1** Dark `micro` contrast: #70757C on #18191B–#212225 ≈ 4.6:1,
  borderline AA at 11px — verify in the visual pass; a fix would be a
  color-token decision (separate slice), never a size change.
- **V-2** People column 14→12px — confirm visually (fits more at 96px
  column width, but weight drops).
- **V-3** 1024–1100px: Projects 4-column grid has ~16px slack
  (736px content vs 720px min) — fine today, monitor if a column is
  ever added.
- **V-4** px-literal utilities (`text-[13px]`, `min-h-[68px]`,
  `minmax(360px,1fr)`) do not scale with user root-font-size overrides
  while rem utilities do — the future tokenization must express the
  scale in rem.
- **V-5** Tablet (<1100px) Meetings meta line wraps; rows grow above
  68px by design (min-height, not fixed height) — accepted behavior.

## 7. Implementation boundary (next slice)

One slice, two independently verifiable sub-changes:

- **A. Projects:** allowlist `features/projects/ProjectListPage.tsx` +
  its unit test. Apply §3.1 Δs only.
- **B. Meetings:** allowlist `features/meetings/MeetingListPage.tsx`,
  `features/meetings/UpcomingMeetings.tsx` + their unit tests. Apply
  §3.2 Δs only.

Out of scope: Sidebar (frozen), TopBar, dialogs, Work Items,
Home / My Work / Notes, color tokens (§4.10), spacing beyond the
documented anatomy/leading deltas, radii, borders, search behavior,
any `@theme` token introduction (implement as per-page class
constants; a shared `components/ui` layer + theme tokens is a separate
architecture decision). No behavior, copy, or API change; stale test
selectors may be updated only where product behavior is unchanged.

**Definition of Done:** `./scripts/agent-verify.sh frontend` green;
extended visual harness (pattern:
`scripts/visual/workspace-content-width-check.mjs`) asserting computed
font-size / line-height / weight / height for every Δ role at
1440 / 1680 / 1920 / 900, Light + Dark (host terminal — agent sandbox
browser gate applies); human visual acceptance recorded;
`docs/CURRENT_STATE.md` checkpoint entry — including correction of the
stale "64px / 14px padding" line and explicit status of §2 density
values (still provisional until that acceptance).

## 8. Record

- v1 (2026-10-06): one-off audit (full inventory, stress-test tables,
  per-line FACTs). v2 (2026-10-06): converted to this durable contract;
  audit-only verbosity removed, mapping + exceptions retained.
- Measurements quoted from the files named in the scope at `4453f5e`;
  where the frozen Sidebar contract and code could drift, code at HEAD
  is the measured source.
