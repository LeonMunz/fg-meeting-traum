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
