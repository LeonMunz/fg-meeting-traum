import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Workspace typography role contract.
//
// The SETTLED semantic typography roles
// (docs/design/workspace-typography-density.md §1) are expressed as the
// small shared `.fg-type-*` classes in src/index.css. Like the token
// contract, this test is value-based at the source level: it asserts
// each role class carries exactly its contracted size / line-height /
// weight (and letter-spacing where the role defines one), so a silent
// drift of a role value fails the suite. It deliberately does NOT
// assert how components combine these classes with per-element
// utilities (color, height, radius, spacing).

const indexCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.css'),
  'utf-8',
)

const roleBlocks = new Map<string, string>()

for (const match of indexCss.matchAll(
  /\.fg-type-([a-z-]+)\s*{\s*(@apply\s+[^\n]+?)\s*}/g,
)) {
  roleBlocks.set(match[1], match[2].trim().replace(/;\s*$/, ''))
}

const expectRole = (role: string, utilities: string[]) => {
  expect(
    roleBlocks.get(role),
    `missing or drifted .fg-type-${role} in src/index.css`,
  ).toBe(`@apply ${utilities.join(' ')}`)
}

describe('workspace typography roles (src/index.css)', () => {
  it('defines exactly the seven settled roles', () => {
    expect([...roleBlocks.keys()].sort()).toEqual([
      'control',
      'meta',
      'micro',
      'page-title',
      'primary-content',
      'record-title',
      'section-heading',
    ])
  })

  it('page-title: 24/28, 600, tracking-tight', () => {
    expectRole('page-title', [
      'text-[24px]',
      'leading-7',
      'font-semibold',
      'tracking-tight',
    ])
  })

  it('section-heading: 16/22, 600', () => {
    expectRole('section-heading', [
      'text-base',
      'leading-[22px]',
      'font-semibold',
    ])
  })

  it('record-title: 14/20, 600', () => {
    expectRole('record-title', [
      'text-sm',
      'leading-5',
      'font-semibold',
    ])
  })

  it('primary-content: 14/20, 400 (no weight override)', () => {
    expectRole('primary-content', ['text-sm', 'leading-5'])
  })

  it('control: 13/18, 500', () => {
    expectRole('control', [
      'text-[13px]',
      'leading-[18px]',
      'font-medium',
    ])
  })

  it('meta: 12/16, 400', () => {
    expectRole('meta', [
      'text-xs',
      'leading-4',
      'font-normal',
    ])
  })

  it('micro: 11/16, 500', () => {
    expectRole('micro', [
      'text-[11px]',
      'leading-4',
      'font-medium',
    ])
  })
})
