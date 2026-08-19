import { describe, expect, it } from 'vitest'

import { roundtripMarkdown } from './markdownExtensions'

// Markdown is the CANONICAL persisted Work Item Description — these are
// regression tests for the parse -> Tiptap document -> serialize round
// trip that every save/reload goes through. They intentionally do not
// assert byte-for-byte output (the serializer is free to normalize
// whitespace/list markers) — they assert that every supported structure
// from the conservative subset survives a round trip recognizably.

describe('markdown round trip — supported subset', () => {
  it('preserves H2 and H3 headings', () => {
    const out = roundtripMarkdown(
      '## Section\n\n### Subsection\n\nBody text.',
    )

    expect(out).toContain('## Section')
    expect(out).toContain('### Subsection')
    expect(out).toContain('Body text.')
  })

  it('preserves bold, italic, strikethrough, and inline code', () => {
    const out = roundtripMarkdown(
      'This is **bold**, this is *italic*, this is ~~struck~~, ' +
        'and this is `inline code`.',
    )

    expect(out).toContain('**bold**')
    expect(out).toContain('*italic*')
    expect(out).toContain('~~struck~~')
    expect(out).toContain('`inline code`')
  })

  it('preserves bullet lists', () => {
    const out = roundtripMarkdown(
      '- Review literature\n- Compare methods\n- Write summary',
    )

    expect(out).toContain('- Review literature')
    expect(out).toContain('- Compare methods')
    expect(out).toContain('- Write summary')
  })

  it('preserves numbered lists', () => {
    const out = roundtripMarkdown(
      '1. First step\n2. Second step\n3. Third step',
    )

    expect(out).toContain('1. First step')
    expect(out).toContain('2. Second step')
    expect(out).toContain('3. Third step')
  })

  it('preserves task lists, including checked state', () => {
    const out = roundtripMarkdown(
      '- [ ] Verify references\n- [x] Draft outline',
    )

    expect(out).toContain('- [ ] Verify references')
    expect(out).toContain('- [x] Draft outline')
  })

  it('preserves blockquotes', () => {
    const out = roundtripMarkdown(
      '> Focus on papers after 2023.',
    )

    expect(out).toContain('> Focus on papers after 2023.')
  })

  it('preserves fenced code blocks verbatim', () => {
    const out = roundtripMarkdown(
      '```\nconst x = 1;\nconsole.log(x);\n```',
    )

    expect(out).toContain('```')
    expect(out).toContain('const x = 1;')
    expect(out).toContain('console.log(x);')
  })

  it('preserves links', () => {
    const out = roundtripMarkdown(
      'See the [project brief](https://example.com/brief) for context.',
    )

    expect(out).toContain(
      '[project brief](https://example.com/brief)',
    )
  })

  it('preserves horizontal rules', () => {
    const out = roundtripMarkdown('Before.\n\n---\n\nAfter.')

    expect(out).toContain('---')
    expect(out).toContain('Before.')
    expect(out).toContain('After.')
  })

  it('round trips the full canonical example from the product spec', () => {
    const sample = [
      '## Expected outcome',
      '',
      '- Review literature',
      '- Compare methods',
      '',
      '- [ ] Verify references',
      '',
      '> Focus on papers after 2023.',
    ].join('\n')

    const out = roundtripMarkdown(sample)

    expect(out).toContain('## Expected outcome')
    expect(out).toContain('- Review literature')
    expect(out).toContain('- Compare methods')
    expect(out).toContain('- [ ] Verify references')
    expect(out).toContain('> Focus on papers after 2023.')
  })

  it('is idempotent — round tripping already-normalized output changes nothing further', () => {
    const sample =
      '## Heading\n\n- one\n- two\n\n- [ ] task\n\n' +
      '> quote\n\n`code` and **bold** and *italic*\n\n' +
      '```\nblock code\n```'

    const once = roundtripMarkdown(sample)
    const twice = roundtripMarkdown(once)

    expect(twice).toBe(once)
  })
})

describe('markdown round trip — existing plain-text descriptions', () => {
  it('renders a plain sentence as a normal paragraph, unchanged', () => {
    const plain =
      'Follow up with the lab about the reagent order next week.'

    expect(roundtripMarkdown(plain)).toBe(plain)
  })

  it('renders a multi-paragraph plain-text description unchanged', () => {
    const plain =
      'First paragraph of context.\n\nSecond paragraph of context.'

    expect(roundtripMarkdown(plain)).toBe(plain)
  })

  it('does not throw on an empty description', () => {
    expect(() => roundtripMarkdown('')).not.toThrow()
  })
})
