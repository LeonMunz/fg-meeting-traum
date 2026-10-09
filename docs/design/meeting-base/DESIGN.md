---
name: Technical Agenda Workspace
colors:
  surface: '#131313'
  surface-dim: '#131313'
  surface-bright: '#393939'
  surface-container-lowest: '#0e0e0e'
  surface-container-low: '#1c1b1b'
  surface-container: '#201f1f'
  surface-container-high: '#2a2a2a'
  surface-container-highest: '#353534'
  on-surface: '#e5e2e1'
  on-surface-variant: '#c3c6d3'
  inverse-surface: '#e5e2e1'
  inverse-on-surface: '#313030'
  outline: '#8d909d'
  outline-variant: '#424752'
  surface-tint: '#acc7ff'
  primary: '#acc7ff'
  on-primary: '#002f68'
  primary-container: '#6898f0'
  on-primary-container: '#002f69'
  inverse-primary: '#245cb0'
  secondary: '#c8c6c5'
  on-secondary: '#313030'
  secondary-container: '#474746'
  on-secondary-container: '#b7b5b4'
  tertiary: '#c8c6c5'
  on-tertiary: '#303030'
  tertiary-container: '#9a9898'
  on-tertiary-container: '#313131'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#d7e2ff'
  primary-fixed-dim: '#acc7ff'
  on-primary-fixed: '#001a40'
  on-primary-fixed-variant: '#004492'
  secondary-fixed: '#e5e2e1'
  secondary-fixed-dim: '#c8c6c5'
  on-secondary-fixed: '#1c1b1b'
  on-secondary-fixed-variant: '#474746'
  tertiary-fixed: '#e5e2e1'
  tertiary-fixed-dim: '#c8c6c5'
  on-tertiary-fixed: '#1b1c1c'
  on-tertiary-fixed-variant: '#474746'
  background: '#131313'
  on-background: '#e5e2e1'
  surface-variant: '#353534'
typography:
  headline-lg:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: 0px
  headline-sm:
    fontFamily: Geist
    fontSize: 15px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: 0px
  body-md:
    fontFamily: Geist
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 22px
    letterSpacing: 0px
  body-sm:
    fontFamily: Geist
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0px
  label-md:
    fontFamily: Geist
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0px
  label-sm:
    fontFamily: Geist
    fontSize: 11px
    fontWeight: '400'
    lineHeight: 14px
    letterSpacing: 0px
spacing:
  gutter: 1rem
  margin: 2rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2rem
---

## Brand & Style

This design system establishes an ultra-focused, modular agenda operating system tailored for deep research, high-friction syntheses, and executive-level alignment. The aesthetic strips away cosmetic fluff in favor of a stark, utilitarian, zero-radius architectural framework.

Rooted in functional minimalism and technical precision, the interface feels like an engineered terminal: quiet, razor-sharp, and devoid of ambiguity. It relies on meticulous structural discipline, strict horizontal baselines, and a singular left-aligned reading axis to keep cognitive load near zero during dense analytical preparation.

## Colors

The palette is engineered around an uncompromising neutral dark canvas that prioritizes visual endurance during multi-hour prep sessions:

- **Page Background (`#121212`):** Ground-level neutral canvas providing deep contrast without harsh absolute black.
- **Section Surface (`#1A1A1A`):** Structural container surface providing zero-shadow planar elevation.
- **Hover Surface (`#222222`):** Subtle tactile feedback for interactive zones, rows, and selection targets.
- **Borders & Dividers (`rgba(255, 255, 255, 0.06)`):** 1px structural demarcations delivering whisper-quiet separation.
- **Text Primary (`#E6E6E6`):** High-legibility text tone; never pure `#FFFFFF` to avoid retinal glare.
- **Text Secondary (`#A3A3A3`):** Descriptive labels, hints, and structural subheads.
- **Text Tertiary (`#8A8A8A`):** Timestamps, metadata, author attributions, and inactive glyphs.
- **Accent Primary (`#6898F0`):** Reserved exclusively for primary action triggers (with text set to `#101114`), explicit focus states, active segment markers, and inline links. Never used decoratively.

## Typography

The typographic hierarchy utilizes Geist set exclusively in sentence case. The following rules govern all type applications:

- **Case and Tracking:** Strictly sentence case throughout. Never use uppercase transformations or custom positive/negative letter spacing.
- **Page Titles:** 24px semibold (`#E6E6E6`) for clear architectural anchoring at the document apex.
- **Section Titles:** 15px semibold (`#E6E6E6`) positioned precisely at section anchors.
- **Topic Content:** 15px regular (`#E6E6E6`) paired with an exact 40px bounding box row rhythm.
- **Metadata & Supplementary Details:** 13px regular using either secondary (`#A3A3A3`) or tertiary (`#8A8A8A`) weights based on prominence.

## Elevation & Depth

Visual hierarchy is constructed entirely through tonal layering and low-contrast surface boundaries rather than drop shadows:

- **Zero Shadows:** Elevation does not employ blur radii or physical drop shadows (`box-shadow: none`).
- **Planar Stacking:** Structural hierarchy uses flat planes: canvas background (`#121212`) sits at baseline 0, while sections and operational cards reside on `#1A1A1A`. Hover states step up to `#222222`.
- **Low-Contrast Outlines:** Surfaces are bounded with a crisp 1px solid stroke (`rgba(255, 255, 255, 0.06)`). Focus rings drop this outline in favor of a 1px solid accent ring in `#6898F0`.

## Shapes

Every component, container, input, tag, and modal possesses a strict zero-radius boundary (`0px`). Geometry is completely orthogonal, emphasizing the modular, technical-terminal persona of the system.

## Components

### Buttons
- **Primary:** Background `#6898F0`, label color `#101114`, 15px semibold, zero radius, 40px height, 16px horizontal padding. Zero shadow. On hover, apply 90% opacity overlay.
- **Secondary / Ghost:** Transparent background with 1px border (`rgba(255, 255, 255, 0.06)`), text `#E6E6E6`. On hover, switch background to `#222222`.
- **Row Trigger ("+ Add topic"):** Height 40px, full-width or inline left-aligned, transparent background, text `#A3A3A3` with a 16px outline icon. On hover, background transitions to `#1A1A1A` and text to `#E6E6E6`.

### Lists & Agenda Topic Rows
- **Row Structure:** 40px fixed height, 1px bottom border (`rgba(255, 255, 255, 0.06)`), 0px radius.
- **Interaction:** Background shifts from transparent/`#1A1A1A` to `#222222` on pointer hover.
- **Iconography:** Strictly 16px outline icons with 1.25px stroke, colored `#8A8A8A` (default) or `#E6E6E6` (active/hover).

### Form Controls
- **Inputs:** 40px height, background `#121212`, 1px border (`rgba(255, 255, 255, 0.06)`), text `#E6E6E6`, 15px regular. Focus state introduces a 1px solid `#6898F0` ring with zero outline offset.
- **Checkboxes:** 16x16px square, zero radius, border 1px solid `#8A8A8A`. Checked state fills `#6898F0` with a `#101114` checkmark.

### Cards & Modular Containers
- **Section Container:** Background `#1A1A1A`, 1px border (`rgba(255, 255, 255, 0.06)`), zero border radius, 0px shadow. Internal padding scales in 8px increments (typically 16px or 24px).