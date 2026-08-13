---
name: Kinetic Research Logic
colors:
  surface: '#f8f9ff'
  surface-dim: '#cbdbf5'
  surface-bright: '#f8f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#eff4ff'
  surface-container: '#e5eeff'
  surface-container-high: '#dce9ff'
  surface-container-highest: '#d3e4fe'
  on-surface: '#0b1c30'
  on-surface-variant: '#464555'
  inverse-surface: '#213145'
  inverse-on-surface: '#eaf1ff'
  outline: '#777587'
  outline-variant: '#c7c4d8'
  surface-tint: '#4d44e3'
  primary: '#3525cd'
  on-primary: '#ffffff'
  primary-container: '#4f46e5'
  on-primary-container: '#dad7ff'
  inverse-primary: '#c3c0ff'
  secondary: '#565e74'
  on-secondary: '#ffffff'
  secondary-container: '#dae2fd'
  on-secondary-container: '#5c647a'
  tertiary: '#7e3000'
  on-tertiary: '#ffffff'
  tertiary-container: '#a44100'
  on-tertiary-container: '#ffd2be'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e2dfff'
  primary-fixed-dim: '#c3c0ff'
  on-primary-fixed: '#0f0069'
  on-primary-fixed-variant: '#3323cc'
  secondary-fixed: '#dae2fd'
  secondary-fixed-dim: '#bec6e0'
  on-secondary-fixed: '#131b2e'
  on-secondary-fixed-variant: '#3f465c'
  tertiary-fixed: '#ffdbcc'
  tertiary-fixed-dim: '#ffb695'
  on-tertiary-fixed: '#351000'
  on-tertiary-fixed-variant: '#7b2f00'
  background: '#f8f9ff'
  on-background: '#0b1c30'
  surface-variant: '#d3e4fe'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  title-md:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  label-caps:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
  mono-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 4px
  container-max: 1440px
  sidebar-width: 240px
  gutter: 24px
  margin-page: 40px
  stack-xs: 4px
  stack-sm: 8px
  stack-md: 16px
  stack-lg: 24px
---

## Brand & Style
The design system is engineered for high-velocity academic and industrial research environments. It prioritizes a **Modern Minimalist** aesthetic with a heavy emphasis on utility and systematic order. The interface behaves like a "Quiet OS"—disappearing to let complex data and documentation take center stage.

The emotional response should be one of "calm focus" and "institutional reliability." Drawing inspiration from high-performance utility tools, the system utilizes a rigid structural grid, ample whitespace for cognitive breathing room, and intentional motion to signal state changes without distracting the user. It rejects decorative elements in favor of functional clarity and high information density.

## Colors
The palette is rooted in a "Paper & Ink" philosophy. The primary background is pure white (#FFFFFF), providing the highest possible contrast for text. Secondary surfaces use subtle greys to define functional zones like sidebars and utility panels.

**Primary Indigo (#4F46E5)** is reserved for high-intent actions, active states, and progress indicators. It should never exceed 5% of the total screen real estate to maintain its psychological impact. 

**Status Indicators:**
- **Tasks:** Use Neutral for 'Pending', Indigo for 'In-Progress', and Success Green for 'Completed'.
- **Goals:** Represented by a monochromatic scale of the primary indigo to show depth of achievement.
- **KVP (Key Value Pairs):** Use a specific violet-tinted indigo for keys to differentiate metadata from body content.

## Typography
This design system utilizes **Inter** for all UI and prose elements to ensure maximum legibility and a neutral, modern tone. **JetBrains Mono** is introduced for metadata, KVP strings, and technical identifiers to provide a clear visual distinction between content and system data.

**Hierarchy Rules:**
- Use `display-lg` exclusively for dashboard overviews or empty state headers.
- `body-md` is the workhorse for all research notes and data entries.
- `label-caps` is used for overlines and section headers in sidebars to provide structure without adding visual weight.
- Use tabular icons/figures for all data-heavy views to prevent "jumping" during real-time updates.

## Layout & Spacing
The layout follows a **Fixed-Fluid Hybrid** model. The main navigation sidebar is fixed at 240px, while the content area fluidly expands up to a maximum of 1440px. This ensures that research papers and data tables do not stretch to illegible widths on ultrawide monitors.

**Rhythm:**
- A 4px baseline grid governs all vertical rhythm.
- **Density:** Use 8px (`stack-sm`) for related items in a list and 16px (`stack-md`) for distinct content blocks.
- **Margins:** Desktop views require a 40px outer margin to prevent the UI from feeling cramped against the browser chrome.

## Elevation & Depth
Depth is conveyed through **Tonal Layering** rather than heavy shadows. The background is white (#FFFFFF), and nested containers or sidebars use light grey (#F9FAFB).

**Shadow Philosophy:**
- **Level 0 (Flat):** Default state for backgrounds and sidebars.
- **Level 1 (Subtle):** `0 1px 2px 0 rgba(0, 0, 0, 0.05)`. Used for cards and input fields to lift them slightly from the page.
- **Level 2 (Floating):** `0 10px 15px -3px rgba(0, 0, 0, 0.1)`. Reserved for progressive disclosure elements like command palettes (Raycast-style), context menus, and dropdowns.

**Borders:**
All containers must have a 1px solid border (#E5E7EB) to define boundaries, ensuring clarity even when shadows are absent.

## Shapes
The design system uses a consistent **Rounded** (8px) corner radius for all primary UI components including buttons, input fields, and cards. This softens the "institutional" feel of the neutral palette while maintaining a professional structure.

- **Small elements (Checkboxes, Tags):** Use `rounded-sm` (4px).
- **Standard containers (Cards, Modals):** Use `rounded-md` (8px).
- **Search bars & Status Pills:** Use `rounded-full` (999px) to indicate high interactivity or self-contained status info.

## Components

### Buttons & Inputs
- **Primary Action:** Solid #4F46E5 with white text. 8px radius.
- **Secondary Action:** White background, #E5E7EB border, #0F172A text.
- **Ghost Action:** No border or background until hover. Use for low-priority toolbar actions.
- **Inputs:** 1px border (#E5E7EB) with a 2px indigo ring on focus. Use `body-sm` for placeholder text.

### Progress & Status
- **Progress Bars:** Thin 4px tracks. Use a subtle grey background with a solid indigo fill.
- **Status Chips:** Small, uppercase labels using `mono-sm`. Use "dot" indicators (e.g., a green dot for 'Active') to save space in dense tables.

### Data Display
- **Cards:** White background, Level 1 shadow, 1px border. No internal padding on card headers; use a 1px bottom divider instead.
- **Lists:** Use alternating row highlights (#F9FAFB) only in data-heavy tables. Otherwise, use transparent backgrounds with 1px dividers.

### Research-Specific Components
- **The Command Palette:** A centered modal (560px width) with a Level 2 shadow. Highlights the active item with a subtle indigo wash (5% opacity).
- **KVP Rows:** Left-aligned keys in `label-caps` (neutral-500) and right-aligned values in `mono-sm` (indigo-600).