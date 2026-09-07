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

const tokens: Record<string, string> = {
  // Neutral structure
  'color-canvas': '#fcfcfd',
  'color-surface': '#ffffff',
  'color-surface-subtle': '#f9f9fb',
  'color-surface-muted': '#f0f0f3',
  'color-surface-hover': '#e8e8ec',

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
}

describe('functional color tokens', () => {
  it.each(Object.entries(tokens))(
    'defines --%s with the approved value',
    (name, expected) => {
      expect(indexCss).toContain(`--${name}: ${expected};`)
    },
  )
})
