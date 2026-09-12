import { beforeAll, describe, expect, it } from 'vitest'

// Theme-contract tests for the Cancel follow-up dialog.
//
// The dialog must resolve entirely through the semantic token system
// (Light and Dark), with no legacy Material compatibility tokens, no
// `dark:` overrides, and no raw hex colors. Class strings are asserted
// on the raw TSX source so the contract tracks the exact utilities.

describe('MeetingCancelFollowUpDialog semantic theme contract', () => {
  let source = ''

  beforeAll(async () => {
    const mod = await import(
      './MeetingCancelFollowUpDialog.tsx?raw'
    )
    source = (mod as { default: string }).default
  })

  it('uses the semantic modal scrim and surface shell', () => {
    expect(source).toContain('bg-overlay-scrim')
    expect(source).toContain(
      'border border-border-structural bg-surface shadow-xl',
    )
    // The legacy static tokens are the cause of the Light-mode
    // appearance in Dark; none may remain.
    expect(source).not.toContain('bg-on-surface/25')
    expect(source).not.toContain('bg-surface-container-lowest')
  })

  it('keeps header and footer dividers on border-border-subtle', () => {
    expect(source).toContain('border-b border-border-subtle')
    expect(source).toContain('border-t border-border-subtle')
    // The bare `border-subtle` spelling is a dead utility; only
    // `border-border-subtle` compiles to the semantic subtle border.
    expect(source).not.toMatch(/(?<!-)border-subtle/)
    expect(source).not.toContain('border-outline-variant')
  })

  it('renders title and supporting copy in primary/secondary text', () => {
    expect(source).toContain('tracking-tight text-text"')
    expect(source).toContain('text-sm text-text-muted"')
    expect(source).toContain('text-xs text-text-muted"')
    expect(source).not.toContain('text-on-surface')
  })

  it('uses semantic danger tokens for the error state', () => {
    expect(source).toContain('bg-danger-bg')
    expect(source).toContain('text-danger"')
    expect(source).not.toContain('bg-error-container')
    expect(source).not.toContain('text-error"')
  })

  it('keeps Keep follow-up neutral with the surface-hover treatment', () => {
    expect(source).toContain('font-medium text-text-muted')
    expect(source).toContain('hover:bg-surface-hover')
    expect(source).toContain('hover:text-text')
    expect(source).toContain('focus-visible:ring-2')
    expect(source).toContain('focus-visible:ring-focus')
    expect(source).toContain('focus-visible:ring-offset-surface')
    expect(source).not.toContain('hover:bg-surface-container-high')
    expect(source).not.toContain('ring-primary')
  })

  it('keeps the destructive confirm on semantic danger with neutral disabled tokens', () => {
    expect(source).toContain('bg-danger')
    expect(source).toContain('text-text-inverse')
    expect(source).toContain('hover:bg-danger/80')
    expect(source).toContain('focus-visible:ring-danger')
    expect(source).toContain('focus-visible:ring-offset-surface')
    // Disabled confirm must be the neutral disabled action treatment,
    // not a washed-out static error-container fill.
    expect(source).toContain('disabled:cursor-not-allowed')
    expect(source).toContain('disabled:bg-action-disabled-bg')
    expect(source).toContain('disabled:text-action-disabled-text')
    expect(source).toContain('disabled:hover:bg-action-disabled-bg')
    expect(source).not.toContain('error-container')
    expect(source).not.toContain('text-on-error-container')
  })

  it('adds no dark: overrides or raw hex colors', () => {
    expect(source).not.toMatch(/dark:/)
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('keeps legacy Material compatibility tokens out of the dialog', () => {
    expect(source).not.toContain('on-surface')
    expect(source).not.toContain('surface-container')
    expect(source).not.toContain('outline-variant')
  })
})
