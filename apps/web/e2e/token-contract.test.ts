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
  'color-action': '#3e63dd',
  'color-action-hover': '#5472e4',
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
