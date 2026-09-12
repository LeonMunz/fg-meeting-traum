import { beforeAll, describe, expect, it } from 'vitest'

// Theme-contract tests for the Schedule follow-up modal.
//
// The dialog must resolve entirely through the semantic token system
// (Light and Dark), with no legacy Material compatibility tokens, no
// `dark:` overrides, and no raw hex colors. Class strings are asserted
// on the raw TSX source so the contract tracks the exact utilities.

describe('MeetingFollowUpSchedulingDialog semantic theme contract', () => {
  let source = ''

  beforeAll(async () => {
    const mod = await import(
      './MeetingFollowUpSchedulingDialog.tsx?raw'
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

  it('styles both selects on semantic control tokens', () => {
    expect(source).toContain('border-border-default bg-surface-quiet')
    expect(source).toContain(
      'focus:border-focus focus:ring-2 focus:ring-focus',
    )
    expect(source).toContain('focus:ring-offset-surface')
    expect(source).not.toContain('focus:border-primary')
    expect(source).not.toContain('ring-primary')
  })

  it('renders the select placeholder in tertiary text', () => {
    expect(source).toContain('text-text-tertiary')
    expect(source).toContain('text-text`')
  })

  it('keeps the disabled Section legible with neutral disabled tokens', () => {
    expect(source).toContain('disabled:cursor-not-allowed')
    expect(source).toContain('disabled:border-border-subtle')
    expect(source).toContain(
      'disabled:text-control-disabled-foreground',
    )
    expect(source).not.toContain('disabled:opacity-55')
  })

  it('keeps Cancel neutral with the surface-hover treatment', () => {
    expect(source).toContain('text-text-muted')
    expect(source).toContain('hover:bg-surface-hover')
    expect(source).toContain('hover:text-text')
    expect(source).toContain('focus-visible:ring-2')
    expect(source).toContain('focus-visible:ring-focus')
    expect(source).not.toContain('hover:bg-surface-container-high')
  })

  it('classifies Schedule as Accent with a neutral disabled fill', () => {
    expect(source).toContain('bg-accent')
    expect(source).toContain('text-text-inverse')
    expect(source).toContain('hover:bg-accent-hover')
    // Disabled Schedule must be the neutral disabled dark surface,
    // not an accent-muted (washed-out purple) treatment.
    expect(source).toContain('disabled:bg-action-disabled-bg')
    expect(source).toContain('disabled:text-action-disabled-text')
    // No Accent hover while disabled.
    expect(source).toContain(
      'disabled:hover:bg-action-disabled-bg',
    )
    expect(source).not.toContain('bg-primary')
    expect(source).not.toContain('hover:bg-primary')
    expect(source).not.toContain('disabled:opacity-45')
  })

  it('uses semantic danger tokens for the error state', () => {
    expect(source).toContain('bg-danger-bg')
    expect(source).toContain('text-danger')
    expect(source).not.toContain('error-container')
  })

  it('adds no dark: overrides or raw hex colors', () => {
    expect(source).not.toMatch(/dark:/)
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('keeps legacy Material compatibility tokens out of the dialog', () => {
    expect(source).not.toContain('on-surface')
    expect(source).not.toContain('surface-container')
    expect(source).not.toContain('outline-variant')
    expect(source).not.toContain('text-primary')
    expect(source).not.toContain('bg-error-container')
  })
})
