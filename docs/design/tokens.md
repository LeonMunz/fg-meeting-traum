# FG Workspace — Color Tokens

Canonical, neutral-first color foundation for the frontend
(`apps/web/src/index.css`, `@theme` block).

FG Workspace defaults to **Dark**. **Light** preserves the existing approved
product palette documented below without value changes. Appearance is a
device-local browser preference with exactly `dark` and `light` choices; it is
not account or domain state. The root `data-theme` attribute switches semantic
tokens centrally, so components continue to consume the same token vocabulary.

## Rule

> **Neutral defines structure. Accent defines interaction and active
> focus. Semantic colors communicate meaning only.**

Do not use Accent for decorative structure, and do not use semantic colors
(success/warning/danger) for anything other than real state.

## Functional tokens (canonical)

All shell / chrome code must use these tokens. Raw hex values and raw Tailwind
palette colors (`blue-*`, `indigo-*`, `emerald-*`, `red-*`, …) must not appear
in migrated components.

### Neutral structure
| Token | Value |
|---|---|
| `canvas` | `#FCFCFD` |
| `surface` | `#FFFFFF` |
| `surface-subtle` | `#F9F9FB` |
| `surface-muted` | `#F0F0F3` |
| `surface-hover` | `#E8E8EC` |
| `surface-quiet` | `#FFFFFF` |
| `surface-header` | `#F9F9FB` |
| `surface-chrome` | `#FFFFFF` |

### Text
| Token | Value |
|---|---|
| `text` | `#1C2024` |
| `text-muted` | `#60646C` |
| `text-inverse` | `#FFFFFF` |

### Borders
| Token | Value |
|---|---|
| `border-subtle` | `#E0E1E6` |
| `border-default` | `#CDCED6` |
| `border-control` | `#8B8D98` |

### Accent (interaction / active focus)
| Token | Value |
|---|---|
| `accent` | `#3E63DD` |
| `accent-hover` | `#3358D4` |
| `accent-text` | `#3A5BC7` |
| `accent-subtle` | `#EDF2FE` |
| `accent-selected` | `#E1E9FF` |

### Focus
| Token | Value |
|---|---|
| `focus` | `#3E63DD` |

### Semantic (meaning only)
| Token | Value |
|---|---|
| `success` | `#218358` |
| `success-bg` | `#F4FBF6` |
| `warning` | `#AB6400` |
| `warning-bg` | `#FEFBE9` |
| `danger` | `#CE2C31` |
| `danger-bg` | `#FFF7F7` |
| `danger-subtle` | `#FEEBEC` |

### Lifecycle (themeable state roles)

| Token | Value |
|---|---|
| `status-active-bg` | `#ECFDF5` |
| `status-active-text` | `#065F46` |

The active-lifecycle badge needs a different physical treatment per theme: a
soft green tint in Light and a restrained neutral in Dark (where a light
green/white pill would read as a bright island on the dark surface). It is
deliberately separate from `success-bg`, which must not be redefined for this.

### Primary action

| Token | Value |
|---|---|
| `action` | `#3525CD` |
| `action-hover` | `#3525CD` |

Primary action buttons keep the frozen legacy Light treatment; Dark themes the
same role to the approved interaction accent.

### Themeable state roles

These roles are consumed only by migrated screens (Projects). Each carries a
**Light value that exactly reproduces the legacy frozen treatment** and a
**Dark value from the approved FG Dark hierarchy**, so the same class renders
correctly in both themes without static Light-only legacy classes.

| Token | Light | Dark | Purpose |
|---|---|---|---|
| `role-owner-bg` | `#E2DFFF` | `#2E3135` | Ownership (Owner) role badge background |
| `role-owner-text` | `#3525CD` | `#EDEEF0` | Ownership (Owner) role badge text |
| `selected-support-bg` | `#DAE2FD` | `#2E3135` | Neutral "selected"/support chip (filter / archive) + Type segmented-card selected segment background |
| `selected-support-text` | `#0B1C30` | `#EDEEF0` | Neutral "selected"/support chip text |
| `option-selected-bg` | `#F2F1FF` | `#2E3135` | Selected Create-project option-card fill (Light = `primary-fixed/45` over the card surface) |
| `option-selected-text` | `#0B1C30` | `#EDEEF0` | Selected Create-project option-card text |
| `tab-active` | `#3525CD` | `#EDEEF0` | Active Project tab text + underline (neutral in Dark; distinct from keyboard focus) |
| `overlay-scrim` | `rgba(11,28,48,.25)` | `rgba(0,0,0,.5)` | Modal dialog scrim |
| `surface-footer` | `rgba(239,244,255,.45)` | `rgba(39,42,45,.3)` | Raised dialog footer band |
| `text-faded` | `rgba(70,69,85,.65)` | `#70757C` | Faded secondary metadata (e.g. archived markers) |
| `link-hover` | `#3525CD` | `#9EB1FF` | Interactive text / back-link hover |
| `control-accent` | `#3525CD` | `#3E63DD` | Native form-control accent (radio) |
| `action-hover-subtle` | `#E2DFFF` | `#272A2D` | Subtle hover tint for a text-only action button |
| `border-standalone` | `#C7C4D8` | `#43484E` | Standalone card / button / empty-state border (Light = legacy `outline-variant`) |
| `border-structural` | `#C7C4D8` | `#363A3F` | Structural border for lists, cards, dividers, tab bar, and banners (Light = legacy `outline-variant`) |
| `border-field` | `#777587` | `#696E77` | Form-control (input / radio-card) border (Light = legacy `outline`) |
| `card-selected-bg` | `rgba(53,37,205,.05)` | `#2E3135` | Selected Work Item (Board card / List row) fill — neutral in Dark |
| `card-selected-ring` | `rgba(53,37,205,.55)` | `#43484E` | Selected Work Item outline ring |
| `drag-target-bg` | `rgba(53,37,205,.06)` | `#272A2D` | Board column highlighted as a drag target (fill) |
| `drag-target-ring` | `rgba(53,37,205,.4)` | `#43484E` | Board drag-target inset ring |
| `workspace` | `#FFFFFF` | `#18191B` | Work Items board workspace body (Light = frozen panel surface; Dark = project canvas) |
| `board-column` | `rgba(239,244,255,.4)` | `transparent` | Work Items board column rest surface (open/transparent in Dark) |
| `segmented-bg` | `#EFF4FF` | `#1E2023` | Board/List segmented control container |
| `segmented-selected` | `#FFFFFF` | `#2E3135` | Segmented control active selection (neutral in Dark) |
| `segmented-selected-text` | `#0B1C30` | `#EDEEF0` | Segmented control active selection text |
| `text-work-faded-70` | `#7E7D88` | `#70757C` | Work Items faded metadata (board column counts; Light = `on-surface-variant/70`) |
| `text-work-faded-75` | `#747480` | `#70757C` | Work Items faded metadata (list header labels; Light = `on-surface-variant/75`) |
| `text-work-placeholder` | `#908F99` | `#70757C` | Work Items search placeholder (Light = `on-surface-variant/60`) |
| `text-work-faded-80` | `#6B6A77` | `#70757C` | Work Items list type icon (Light = `on-surface-variant/80`) |
| `work-items-header` | `#FFFFFF` | `#1B1D20` | Work Items header band (Light = frozen white panel; Dark = chrome) |
| `work-item-error` | `#BA1A1A` | `#CE2C31` | Work Items error/danger text (Light = legacy `error`) |
| `work-item-error-bg` | `#FFF2F1` | `#2A1A1C` | Work Items error banner fill (Light = `error-container/35`) |
| `work-item-error-border` | `#E7AFAF` | `#5A2B2E` | Work Items emphasized/blocked border (Light = `error/35`) |

**Legacy-visual bridges (Work Items Board/List).** The HEAD Board/List rendered
several roles through legacy Material tokens that are *static* across themes
(no Dark override). These bridges reproduce the exact frozen Light visual while
giving each bounded role a theme-aware Dark value. None alter a global
functional token.

| Role | Light | Dark | Purpose |
|---|---|---|---|
| `work-content-text` | `#0B1C30` | `#EDEEF0` | Strong content text (Light = legacy `on-surface`, distinct from canonical `text` `#1C2024`) |
| `work-content-muted` | `#464555` | `#AFB3BA` | Ordinary muted metadata (Light = legacy `on-surface-variant`, distinct from canonical `text-muted`) |
| `work-surface-support` | `#DCE9FF` | `#2E3135` | Neutral support fill — count / readonly badges, avatar + empty-state icon (Light = legacy `surface-container-high`) |
| `work-surface-hover` | `#EFF4FF` @45% | `#272A2D` | Work Item card / List row hover (Light = legacy `surface-container-low/45`) |
| `work-surface-toolbar` | `#EFF4FF` @35% | `#1B1D20` | Filter / toolbar band (Light = legacy `surface-container-low/35`) |
| `action-hover-solid` | `#3525CD` @90% | `#5472E4` | New Work Item button hover (Light = legacy `primary/90`; Dark = action-hover) |
| `interaction-primary` | `#3525CD` | `#3E63DD` | Legacy-primary interaction accent — insertion indicator, in-progress status, task-list checkbox accent (Light = legacy `primary`) |
| `prose-link` | `#3525CD` | `#9EB1FF` | Prose text link (`.fg-prose a`); Light = legacy `primary`, the exact HEAD link foreground |
| `focus-ring-primary` | `#3525CD` | `#3E63DD` | Form-control focus border / ring (Light = legacy `primary` and `primary/15`) |

**Overlay soft scrim, drawer faded text, note band, row hover, and
themeable shadow color.** The Work Item drawer migration retained the
minimum set of roles whose HEAD Light values are NOT expressible by the
existing functional tokens:

- The create drawer is a dedicated right-side overlay, so its Light scrim is
  `bg-black/30` (distinct from the centered-modal `overlay-scrim` =
  `on-surface/25`); the delete dialog scrim IS `on-surface/25` and reuses
  `overlay-scrim` directly.
- The drawer's three legacy `on-surface-variant` @55/60/70 text tiers are
  exact opaque composites over white (e.g. /60 = `#908F99`); the /60 value
  equals `text-work-placeholder` but stays a distinct role because it must
  theme to muted in Dark while the Board placeholder must not.
- The quiet note band (read-only notice, "Created from" box) is
  `surface-container-low/50` — a different Light alpha from
  `work-surface-toolbar` (`/35`), so it is a distinct role.
- Property-row hover is `surface-container-low` UNCOMPOSITED — different
  from `work-surface-hover` (`/45`), so it is a distinct role.
- Drawer popup shadows keep the native Tailwind geometries (sm/lg/xl/2xl)
  byte-for-byte in Light; only the shadow COLOR is themed via
  `--shadow-color`, so Dark gets a black shadow instead of the pale
  `on-surface` glow with zero Light change.

| Token | Light | Dark | Purpose |
|---|---|---|---|
| `overlay-soft-scrim` | `#000000` @30% | `#000000` @50% | Work Item create-drawer backdrop (right-side overlay) |
| `text-work-faded-55` | `#9999A2` | `#70757C` | Drawer input placeholder (Light = `on-surface-variant/55` over white) |
| `text-work-faded-60` | `#908F99` | `#70757C` | Drawer faded metadata: history timestamps, change labels, timeline dot (Light = `on-surface-variant/60`) |
| `text-work-faded-70` | `#7E7D88` | `#70757C` | Drawer muted metadata: descriptions, timestamps, labels, loading/empty (Light = `on-surface-variant/70`) |
| `work-surface-note` | `#F7FAFF` | `#1E2023` | Quiet note band (Light = `surface-container-low/50` over white) |
| `work-surface-row-hover` | `#EFF4FF` | `#272A2D` | Drawer row / disabled-field hover (Light = `surface-container-low` uncomposited) |
| `shadow-color` | `#000000` @100% | `#000000` @50% | Themeable shadow color for drawer-owned popups (native geometries preserved) |
**Inspector control bridges.** The Work Item Inspector consumes a set of
generic control/foreground bridge roles. Each Light value is the **exact
HEAD rendering** of the corresponding state (the legacy Material tokens were
static across themes, so their Light values survive verbatim — several as
opaque composites over white: `#464555` = `on-surface-variant`, `#5C5B6A` =
`on-surface-variant/80`, `#575666` = `on-surface-variant/40`, `#5C5D6B` =
`primary/40`, `#1D2746` = `primary/15`, `#F8D0CE` = `error-container/40`,
`#C7C4D8` = `outline-variant`, `#DCE9FF` = `surface-container-high`,
`#FFFFFF` = `on-primary`). The Dark side uses the approved FG Dark
hierarchy. No existing token is forced to serve both themes when its Light
side does not match HEAD.

| Token | Light (HEAD-exact) | Dark | Purpose |
|---|---|---|---|
| `text-primary` | `#0B1C30` | `#EDEEF0` | Strong content text (property values, chip name, editor input text, control hover foreground) |
| `text-secondary` | `#464555` | `#AFB3BA` | Ordinary metadata (project crumb, chip initials / remove icon) |
| `text-tertiary` | `#5C5B6A` | `#8B9098` | Quiet metadata: property labels (Type/Status/Assignees/Due date/Parent/Blocked), toolbar inactive text, "Markdown supported" hint, editor placeholder |
| `control-foreground` | `#464555` | `#AFB3BA` | Normal interactive control icons (search, more_horiz, Link-popover label) |
| `control-hover-foreground` | `#0B1C30` | `#EDEEF0` | Control icon foreground on hover |
| `control-hover-surface` | `#DCE9FF` | `#272A2D` | Toolbar button hover background |
| `control-active-foreground` | `#3525CD` | `#9EB1FF` | Active toolbar formatting state (text/icon) |
| `control-active-surface` | `#1D2746` | `#15224C` | Active toolbar formatting state (background) |
| `control-disabled-foreground` | `#575666` | `#696E77` | Disabled toolbar control (Light = `on-surface-variant/40`, exact HEAD disabled opacity composite) |
| `action-disabled-bg` | `#5C5D6B` | `#2E3135` | Disabled Comment/Save fill (Light = `primary/40` over white, exact HEAD disabled-button composite) |
| `action-disabled-text` | `#5C5D6B` | `#696E77` | Disabled Comment/Save text |
| `quiet-action-foreground` | `#464555` | `#AFB3BA` | Cancel (default) |
| `quiet-action-hover-foreground` | `#0B1C30` | `#EDEEF0` | Cancel hover text |
| `quiet-action-hover-surface` | `#DCE9FF` | `#272A2D` | Cancel hover background |
| `control-track-off` | `#DCE9FF` | `#3F444B` | Blocked toggle off-track (visible structural fill in Dark; HEAD filled track in Light) |
| `editor-boundary` | `#C7C4D8` | `#43484E` | Interactive editor/input boundary (comment composer frame, Link-popover field) — subtle in Light (HEAD `outline-variant`), control-strength in Dark |

**Shared editor prose (`.fg-prose`).** The default rules keep their exact
HEAD Light rendering byte-for-byte — the legacy tokens they reference
(`on-surface`, `on-surface-variant`, `primary`, `outline-variant`,
`surface-container-high`) are static and Light-correct, and the Light
placeholder opacity chain is preserved. A Dark-only override block
(`html[data-theme='dark'] .fg-prose …`, appended after the defaults) maps
each prose state to the theme-aware semantic tokens: body / headings /
list / `pre code` → `text-primary`; blockquote + checked-task text →
`text-secondary` (strike line → `border-subtle`); placeholder →
`text-tertiary` (opacity reset to 1); links → `prose-link` (same 40%
underline, same hover); task-list checkbox accent →
`interaction-primary`; inline code / code-block fill →
`work-surface-support`; quote bar / `<hr>` → `border-subtle`. The override
is additive (higher specificity than the defaults), so Light `.fg-prose`
rendering is exactly HEAD.

**Semantic success text.** The Work Item Done status glyph needed a readable
semantic green in Dark while keeping the exact legacy Light value.

| Role | Light | Dark | Purpose |
|---|---|---|---|
| `success-text` | `#047857` | `#3DD68C` | Semantic success text — Work Item Done status (Light = legacy `text-emerald-700`). Distinct from the `success` fill token, which is unchanged. |

Note the two distinct "selected" fills: the **chip** uses a light
secondary-container tint (`#DAE2FD`) while the **option card** composites
`primary-fixed` at 45% over the card surface (`#F2F1FF`). They are kept as
separate roles because their Light values differ; Dark converges both to the
restrained neutral `#2E3135`.

## Dark mapping — FG Dark, Dim Slate

Dark Mode overrides the functional tokens at `html[data-theme='dark']`.
The shell maps `surface-subtle` to the darker sunken Sidebar,
`surface-hover` to hover/raised treatment, and `surface-muted` to selected and
active treatment. `surface-quiet`, `surface-header`, and `surface-chrome`
preserve their existing Light roles while keeping large Dark content surfaces
and translucent chrome closer to the canvas.

| Token | Dark value |
|---|---|
| `canvas` | `#18191B` |
| `surface` | `#212225` |
| `surface-subtle` | `#111113` |
| `surface-muted` | `#2E3135` |
| `surface-hover` | `#272A2D` |
| `surface-quiet` | `#1E2023` |
| `surface-header` | `#1B1D20` |
| `surface-chrome` | `#1B1D20` |
| `text` | `#EDEEF0` |
| `text-muted` | `#AFB3BA` |
| `text-inverse` | `#FFFFFF` |
| `border-subtle` | `#363A3F` |
| `border-default` | `#43484E` |
| `border-control` | `#696E77` |
| `accent` | `#3E63DD` |
| `accent-hover` | `#5472E4` |
| `accent-text` | `#9EB1FF` |
| `accent-subtle` | `#15224C` |
| `accent-selected` | `#15224C` |
| `focus` | `#3E63DD` |
| `status-active-bg` | `#2E3135` |
| `status-active-text` | `#EDEEF0` |
| `action` | `#3E63DD` |
| `action-hover` | `#5472E4` |

The initial slice themes the document, App Shell, Sidebar, TopBar, navigation,
and global Settings Appearance surface. Feature pages that still use the
compatibility tokens require their own later Dark migration.

## Keyboard focus

One canonical visible focus treatment: a 2px ring in `focus`, with an offset
that separates the ring from the control edge. Use `focus-visible` so mouse
users do not see it, and keep it visually distinct from hover/selection:

```
focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus
focus-visible:ring-offset-2 focus-visible:ring-offset-surface
```

Use an inset (`ring-inset`) treatment instead of an offset when the control is
flush against a container edge with no surrounding space.

Do not keep arbitrary per-component opacity variants such as
`ring-primary/15`, `ring-primary/30`, `ring-primary/40` in migrated chrome.

## Compatibility / migration policy

The legacy Material-style tokens (`primary`, `surface`, `on-surface`,
`outline`, `error`, `surface-container-*`, …) remain in `@theme` as a
**temporary compatibility layer** and keep their **original pre-migration
values**. Their job is to preserve the existing appearance of feature screens
until each area is explicitly migrated.

- Functional tokens are canonical for new and migrated code (shell/chrome).
- Legacy tokens temporarily retain their old values; unmigrated feature
  screens (Meetings, Projects, Work Items, Dashboard, Research Group settings,
  `.fg-prose` editor) continue to render exactly as before the foundation was
  introduced.
- Migration is feature-by-feature. As a feature area is migrated, replace its
  legacy token usages with functional tokens and remove any direct raw palette
  colors / hex values. Do not use legacy aliases to recolor unmigrated screens.
- Do **not** rename legacy tokens repo-wide. Remove a legacy token only when no
  feature screen consumes it.

### Temporary `legacy-surface` token

The old Material `surface` name collided with the new canonical functional
`surface` token (`#FFFFFF`, used by the migrated shell). To preserve the
historical appearance of the one unmigrated consumer (a Dashboard card that
used legacy `surface` = `#F8F9FF`), a temporary compatibility token was added:

- `--color-legacy-surface: #F8F9FF`

It exists **only** to keep that unmigrated Dashboard surface at its exact
pre-migration value (`#F8F9FF`). It must not be used anywhere else. Remove it
when the Dashboard is intentionally migrated to the functional tokens.

## Contract

`apps/web/e2e/token-contract.test.ts` asserts the functional tokens exist with
the approved values. Run it with:

```bash
npm run test:tokens --workspace=web
```
