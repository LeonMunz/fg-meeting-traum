import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Token contract for the neutral-first FG color system.
//
// This asserts the canonical functional tokens exist in the theme layer
// (index.css) with their approved values. It is deliberately value-based,
// not class-string based, so it stays stable across component refactors.
//
// Rule under test:
//   Neutral defines structure; Accent defines interaction/active focus;
//   semantic colors communicate meaning only.

const indexCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.css'),
  'utf-8',
)

const indexHtml = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../index.html'),
  'utf-8',
)

const lightTheme = indexCss.match(
  /@theme\s*{([\s\S]*?)\n}/,
)?.[1]

const darkTheme = indexCss.match(
  /html\[data-theme='dark'\]\s*{([\s\S]*?)\n}/,
)?.[1]

const tokens: Record<string, string> = {
  // Neutral structure
  'color-canvas': '#fcfcfd',
  'color-surface': '#ffffff',
  'color-surface-subtle': '#f9f9fb',
  'color-surface-muted': '#f0f0f3',
  'color-surface-hover': '#e8e8ec',
  'color-surface-quiet': '#ffffff',
  'color-surface-header': '#f9f9fb',
  'color-surface-chrome': '#ffffff',

  // Text
  'color-text': '#1c2024',
  'color-text-muted': '#60646c',
  'color-text-inverse': '#ffffff',

  // Borders
  'color-border-subtle': '#e0e1e6',
  'color-border-default': '#cdced6',
  'color-border-control': '#8b8d98',

  // Accent
  'color-accent': '#3e63dd',
  'color-accent-hover': '#3358d4',
  'color-accent-text': '#3a5bc7',
  'color-accent-subtle': '#edf2fe',
  'color-accent-selected': '#e1e9ff',

  // Focus
  'color-focus': '#3e63dd',

  // Semantic
  'color-success': '#218358',
  'color-success-bg': '#f4fbf6',
  'color-success-text': '#047857',
  'color-warning': '#ab6400',
  'color-warning-bg': '#fefbe9',
  'color-danger': '#ce2c31',
  'color-danger-bg': '#fff7f7',
  'color-danger-subtle': '#feebec',

  // Lifecycle / primary action (themeable roles with distinct Light/Dark values)
  'color-status-active-bg': '#ecfdf5',
  'color-status-active-text': '#065f46',
  'color-action': '#3525cd',
  'color-action-hover': '#3525cd',

  // Project role badge (ownership/role pill) + neutral selection — themeable roles
  // with distinct Light/Dark physical values.
  'color-role-owner-bg': '#e2dfff',
  'color-role-owner-text': '#3525cd',
  'color-selected-neutral-bg': '#dae2fd',
  'color-selected-neutral-text': '#0b1c30',
  'color-option-selected-bg': '#f2f1ff',
  'color-option-selected-text': '#0b1c30',
  'color-tab-active': '#3525cd',
  'color-overlay-scrim': 'rgba(11, 28, 48, 0.25)',
  'color-surface-footer': 'rgba(239, 244, 255, 0.45)',
  'color-text-faded': 'rgba(70, 69, 85, 0.65)',
  'color-link-hover': '#3525cd',
  'color-control-accent': '#3525cd',
  'color-action-hover-subtle': '#e2dfff',
  'color-border-standalone': '#c7c4d8',
  'color-border-structural': '#c7c4d8',
  'color-border-field': '#777587',
  'color-card-selected-bg': 'rgba(53, 37, 205, 0.05)',
  'color-card-selected-ring': 'rgba(53, 37, 205, 0.55)',
  'color-drag-target-bg': 'rgba(53, 37, 205, 0.06)',
  'color-drag-target-ring': 'rgba(53, 37, 205, 0.4)',
  'color-workspace': '#ffffff',
  'color-board-column': 'rgba(239, 244, 255, 0.4)',
  'color-segmented-bg': '#eff4ff',
  'color-segmented-selected': '#ffffff',
  'color-segmented-selected-text': '#0b1c30',
  'color-text-work-faded-70': '#7e7d88',
  'color-text-work-faded-75': '#747480',
  'color-text-work-placeholder': '#908f99',
  'color-text-work-faded-80': '#6b6a77',
  'color-work-items-header': '#ffffff',
  'color-work-item-error': '#ba1a1a',
  'color-work-item-error-bg': '#fff2f1',
  'color-work-item-error-border': '#e7afaf',
  // Legacy-visual bridges (Work Items Board/List) — see index.css for rationale.
  'color-work-content-text': '#0b1c30',
  'color-work-content-muted': '#464555',
  'color-work-surface-support': '#dce9ff',
  'color-work-surface-hover': '#eff4ff73',
  'color-work-surface-toolbar': '#eff4ff59',
  'color-action-hover-solid': '#3525cde6',
  'color-interaction-primary': '#3525cd',
  'color-focus-ring-primary': '#3525cd',
}

describe('functional color tokens', () => {
  it('contains the canonical Light and Dark theme layers', () => {
    expect(lightTheme).toBeDefined()
    expect(darkTheme).toBeDefined()
  })

  it.each(Object.entries(tokens))(
    'keeps the Light --%s value unchanged',
    (name, expected) => {
      expect(lightTheme).toContain(`--${name}: ${expected};`)
    },
  )
})

const darkTokens: Record<string, string> = {
  'color-canvas': '#18191b',
  'color-surface': '#212225',
  'color-surface-subtle': '#111113',
  'color-surface-muted': '#2e3135',
  'color-surface-hover': '#272a2d',
  'color-surface-quiet': '#1e2023',
  'color-surface-header': '#1b1d20',
  'color-surface-chrome': '#1b1d20',
  'color-text': '#edeef0',
  'color-text-muted': '#afb3ba',
  'color-text-inverse': '#ffffff',
  'color-border-subtle': '#363a3f',
  'color-border-default': '#43484e',
  'color-border-control': '#696e77',
  'color-accent': '#3e63dd',
  'color-accent-hover': '#5472e4',
  'color-accent-text': '#9eb1ff',
  'color-accent-subtle': '#15224c',
  'color-accent-selected': '#15224c',
  'color-focus': '#3e63dd',

  // Lifecycle / primary action Dark treatment
  'color-status-active-bg': '#2e3135',
  'color-status-active-text': '#edef0',
  'color-success-text': '#3dd68c',
  'color-action': '#3e63dd',
  'color-action-hover': '#5472e4',

  'color-role-owner-bg': '#2e3135',
  'color-role-owner-text': '#edeef0',
  'color-selected-neutral-bg': '#2e3135',
  'color-selected-neutral-text': '#edeef0',
  'color-option-selected-bg': '#2e3135',
  'color-option-selected-text': '#edeef0',
  'color-tab-active': '#edeef0',
  'color-overlay-scrim': 'rgba(0, 0, 0, 0.5)',
  'color-surface-footer': 'rgba(39, 42, 45, 0.3)',
  'color-text-faded': '#70757c',
  'color-link-hover': '#9eb1ff',
  'color-control-accent': '#3e63dd',
  'color-action-hover-subtle': '#272a2d',
  'color-border-standalone': '#43484e',
  'color-border-structural': '#363a3f',
  'color-border-field': '#696e77',
  'color-card-selected-bg': '#2e3135',
  'color-card-selected-ring': '#43484e',
  'color-drag-target-bg': '#272a2d',
  'color-drag-target-ring': '#43484e',
  'color-workspace': '#18191b',
  'color-board-column': 'transparent',
  'color-segmented-bg': '#1e2023',
  'color-segmented-selected': '#2e3135',
  'color-segmented-selected-text': '#edeef0',
  'color-text-work-faded-70': '#70757c',
  'color-text-work-faded-75': '#70757c',
  'color-text-work-placeholder': '#70757c',
  'color-text-work-faded-80': '#70757c',
  'color-work-items-header': '#1b1d20',
  'color-work-item-error': '#ce2c31',
  'color-work-item-error-bg': '#2a1a1c',
  'color-work-item-error-border': '#5a2b2e',
  'color-work-content-text': '#edeef0',
  'color-work-content-muted': '#afb3ba',
  'color-work-surface-support': '#2e3135',
  'color-work-surface-hover': '#272a2d',
  'color-work-surface-toolbar': '#1b1d20',
  'color-action-hover-solid': '#5472e4',
  'color-interaction-primary': '#3e63dd',
  'color-focus-ring-primary': '#3e63dd',
}

describe('FG Dark — Dim Slate tokens', () => {
  it.each(Object.entries(darkTokens))(
    'maps --%s to %s',
    (name, expected) => {
      expect(darkTheme).toContain(`--${name}: ${expected};`)
    },
  )
})

describe('appearance bootstrap contract', () => {
  it('defaults to Dark and resolves storage before the React module', () => {
    const bootstrapPosition = indexHtml.indexOf(
      "window.localStorage.getItem(storageKey)",
    )
    const reactModulePosition = indexHtml.indexOf(
      'src="/src/main.tsx"',
    )

    expect(indexHtml).toContain("let appearance = 'dark'")
    expect(bootstrapPosition).toBeGreaterThan(-1)
    expect(reactModulePosition).toBeGreaterThan(bootstrapPosition)
    expect(indexHtml).not.toContain('prefers-color-scheme')
    expect(indexHtml).not.toContain('matchMedia')
  })
})
