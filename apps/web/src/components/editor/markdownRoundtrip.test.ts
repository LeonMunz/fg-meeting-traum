import { describe, expect, it } from 'vitest'

import {
  isMarkdownContentEmpty,
  markdownToPlainText,
  roundtripMarkdown,
} from './markdownExtensions'

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

// Comments (variant="compact") are a strictly SMALLER Markdown subset
// than Description — see markdownExtensions.ts. These mirror the `full`
// suite above for every construct compact is supposed to keep, then
// separately prove the constructs it deliberately drops.

describe('markdown round trip — compact (Comments) supported subset', () => {
  it('preserves a plain sentence as a normal paragraph, unchanged', () => {
    const plain = 'Can we confirm the final references before merging?'

    expect(roundtripMarkdown(plain, 'compact')).toBe(plain)
  })

  it('preserves bold, italic, and inline code', () => {
    const out = roundtripMarkdown(
      'This is **bold**, this is *italic*, and this is `inline code`.',
      'compact',
    )

    expect(out).toContain('**bold**')
    expect(out).toContain('*italic*')
    expect(out).toContain('`inline code`')
  })

  it('preserves links', () => {
    const out = roundtripMarkdown(
      'See the [project brief](https://example.com/brief) for context.',
      'compact',
    )

    expect(out).toContain('[project brief](https://example.com/brief)')
  })

  it('preserves bullet lists', () => {
    const out = roundtripMarkdown(
      '- Check references\n- Check figures',
      'compact',
    )

    expect(out).toContain('- Check references')
    expect(out).toContain('- Check figures')
  })

  it('preserves numbered lists', () => {
    const out = roundtripMarkdown(
      '1. First step\n2. Second step',
      'compact',
    )

    expect(out).toContain('1. First step')
    expect(out).toContain('2. Second step')
  })

  it('round trips the canonical example from the product spec', () => {
    const sample = [
      'We should **verify this** before merging.',
      '',
      '- Check references',
      '- Check figures',
    ].join('\n')

    const out = roundtripMarkdown(sample, 'compact')

    expect(out).toContain('We should **verify this** before merging.')
    expect(out).toContain('- Check references')
    expect(out).toContain('- Check figures')
  })

  it('does not throw on an empty comment', () => {
    expect(() => roundtripMarkdown('', 'compact')).not.toThrow()
  })
})

describe('markdown round trip — compact (Comments) unsupported constructs', () => {
  // Regression for the specific failure mode this schema had to be
  // guarded against: a pre-existing plain-text Comment that happens to
  // start with a literal "#"/"##" (e.g. someone's own "# TODO" marker,
  // written before Comments were Markdown at all) must still load as
  // ordinary text — never throw, never silently lose the words after the
  // "#" — even though compact has no heading node at all to put it in.
  // See compactFallbackExtensions in markdownExtensions.ts.
  it('never throws on, and never produces, a heading — even from literal "#" text', () => {
    expect(() =>
      roundtripMarkdown('## Not a real heading, just habit', 'compact'),
    ).not.toThrow()

    const out = roundtripMarkdown(
      '## Not a real heading, just habit',
      'compact',
    )

    expect(out).not.toContain('##')
    expect(out).toContain('Not a real heading, just habit')
  })

  it('never produces a heading for a heading-only comment', () => {
    const out = roundtripMarkdown('# Just a heading only', 'compact')

    expect(out).not.toContain('#')
    expect(out).toContain('Just a heading only')
  })

  it('degrades a blockquote to a plain paragraph, keeping the text', () => {
    const out = roundtripMarkdown(
      '> Focus on papers after 2023.',
      'compact',
    )

    expect(out).not.toContain('>')
    expect(out).toContain('Focus on papers after 2023.')
  })

  it('does not throw on, and keeps the text of, a fenced code block', () => {
    expect(() =>
      roundtripMarkdown('```\nconst x = 1;\n```', 'compact'),
    ).not.toThrow()

    const out = roundtripMarkdown('```\nconst x = 1;\n```', 'compact')

    expect(out).not.toContain('```')
    expect(out).toContain('const x = 1;')
  })

  it('drops a horizontal rule without throwing', () => {
    expect(() =>
      roundtripMarkdown('Before.\n\n---\n\nAfter.', 'compact'),
    ).not.toThrow()
  })

  it('strips strikethrough, keeping the text as plain text', () => {
    const out = roundtripMarkdown('This is ~~struck~~ text.', 'compact')

    expect(out).not.toContain('~~')
    expect(out).toContain('struck')
  })
})

describe('isMarkdownContentEmpty', () => {
  it('treats an empty string as empty', () => {
    expect(isMarkdownContentEmpty('', 'compact')).toBe(true)
  })

  it('treats whitespace-only Markdown as empty', () => {
    expect(isMarkdownContentEmpty('   \n\n  ', 'compact')).toBe(true)
  })

  it('treats an empty bullet item as empty, despite non-empty Markdown text', () => {
    // A bare "-" (no text after it) parses to a real bulletList
    // containing one empty paragraph — non-empty as a raw string
    // (`'-'.trim() !== ''`), but visually blank, which is exactly the
    // gap a plain `.trim()` check would miss.
    expect(isMarkdownContentEmpty('-', 'compact')).toBe(true)
  })

  it('treats real text content as non-empty', () => {
    expect(isMarkdownContentEmpty('Looks good to me.', 'compact')).toBe(
      false,
    )
  })

  it('treats a bullet item with real text as non-empty', () => {
    expect(
      isMarkdownContentEmpty('- Check references', 'compact'),
    ).toBe(false)
  })
})

// Used for the quiet, plain-text History/Activity summary line for a
// blockedReason change — never for rendered content.
describe('markdownToPlainText', () => {
  it('returns a plain sentence unchanged', () => {
    expect(
      markdownToPlainText(
        'Waiting for reviewer feedback.',
        'compact',
      ),
    ).toBe('Waiting for reviewer feedback.')
  })

  it('strips bold/italic/inline-code syntax, keeping the text', () => {
    const out = markdownToPlainText(
      'Waiting for **reviewer feedback** on `the draft`.',
      'compact',
    )

    expect(out).not.toContain('**')
    expect(out).not.toContain('`')
    expect(out).toContain('reviewer feedback')
    expect(out).toContain('the draft')
  })

  it('strips link syntax, keeping the link text', () => {
    const out = markdownToPlainText(
      'See [the ticket](https://example.com/1) for context.',
      'compact',
    )

    expect(out).not.toContain('[')
    expect(out).not.toContain('](')
    expect(out).toContain('the ticket')
  })

  it('flattens a bullet list into readable text, not raw markers', () => {
    const out = markdownToPlainText(
      'Waiting for **reviewer feedback**.\n\n- Reviewer 1\n- Reviewer 2',
      'compact',
    )

    expect(out).not.toContain('**')
    expect(out).not.toContain('- ')
    expect(out).toContain('reviewer feedback')
    expect(out).toContain('Reviewer 1')
    expect(out).toContain('Reviewer 2')
  })

  it('returns an empty string for empty Markdown', () => {
    expect(markdownToPlainText('', 'compact')).toBe('')
  })
})
